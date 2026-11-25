#!/usr/bin/env bash
#
# 在真实的 dsh-docker 发布镜像里验证本插件的宿主半侧：
#   1. 打包产物能通过 `dsh plugin add` 装进 profile，并自动登记为 bundle；
#   2. 重启后插件随 profile 加载，`/api/yimu-bill/status` 可以应答；
#   3. 「扫码登录」端点能真实连到一木云端并返回二维码 PNG。
#
# 用法（CI 与本地一致）：
#   IMAGE=ghcr.io/meixu6693/dsh:0.2.3-alpha.2 \
#   PLUGIN_TARBALL=./dsh-yimu-bill-0.2.5.tgz \
#   bash scripts/test-image-compat.sh
#
# 可选：PORT（默认 18080）、DSH_TEST_PASSWORD（默认仅用于本容器的临时密码）。
# 脚本会创建并删除一个一次性容器；失败时保留容器日志到 stdout 后退出 1。
set -Eeuo pipefail

IMAGE="${IMAGE:?set IMAGE to a released dsh user image, e.g. ghcr.io/meixu6693/dsh:0.2.3-alpha.2}"
PLUGIN_TARBALL="${PLUGIN_TARBALL:?set PLUGIN_TARBALL to the npm pack output of this repository}"
PORT="${PORT:-18080}"
PASSWORD="${DSH_TEST_PASSWORD:-compat-test-password}"
NAME="dsh-yimu-compat-$$"
WORKDIR="$(mktemp -d)"
FAILURES=0

cleanup() {
  docker rm --force "${NAME}" >/dev/null 2>&1 || true
  # The container hands /data and /workspace to its own uid, which may not be ours.
  rm -rf "${WORKDIR}" 2>/dev/null || sudo rm -rf "${WORKDIR}" 2>/dev/null || true
}
trap cleanup EXIT

pass() { printf 'ok   %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

if [[ ! -f "${PLUGIN_TARBALL}" ]]; then
  printf 'plugin tarball not found: %s\n' "${PLUGIN_TARBALL}" >&2
  exit 2
fi

mkdir -p "${WORKDIR}/data" "${WORKDIR}/workspace"

printf 'starting %s\n' "${IMAGE}"
docker run --detach --name "${NAME}" \
  --env 'ALLOWED_CLIENTS=127.0.0.1,172.16.0.0/12' \
  --env "DSH_PASSWORD=${PASSWORD}" \
  --publish "127.0.0.1:${PORT}:8080" \
  --security-opt seccomp=unconfined \
  --security-opt systempaths=unconfined \
  --volume "${WORKDIR}/data:/data" \
  --volume "${WORKDIR}/workspace:/workspace" \
  "${IMAGE}" >/dev/null

wait_health() {
  local attempt
  for attempt in $(seq 1 90); do
    if curl --silent --fail --max-time 3 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "${NAME}" 2>/dev/null)" != "true" ]]; then
      printf 'container exited before /healthz answered\n'
      docker logs "${NAME}" || true
      return 1
    fi
    sleep 2
  done
  printf '/healthz never answered on port %s\n' "${PORT}"
  docker logs "${NAME}" || true
  return 1
}

if wait_health; then
  pass '/healthz answers before the plugin is installed'
else
  fail 'the image did not become healthy'
  exit 1
fi

IMAGE_DSH_VERSION="$(docker exec "${NAME}" sh -c 'sed -n "s/^DSH_VERSION=//p" /etc/dsh-version' 2>/dev/null || true)"
IMAGE_REVISION="$(docker exec "${NAME}" sh -c 'sed -n "s/^DSH_REVISION=//p" /etc/dsh-version' 2>/dev/null || true)"
printf 'image dsh=%s revision=%s\n' "${IMAGE_DSH_VERSION:-unknown}" "${IMAGE_REVISION:-unknown}"

# 以镜像自身运行 DSH 的用户安装，避免把 profile 文件写成 root 所有。
docker cp "${PLUGIN_TARBALL}" "${NAME}:/tmp/dsh-yimu-bill.tgz" >/dev/null
if docker exec --user 1000:1000 "${NAME}" \
  dsh plugin --profile web add /tmp/dsh-yimu-bill.tgz; then
  pass 'dsh plugin add installs the packed plugin into the image profile'
else
  fail 'dsh plugin add failed inside the image'
  docker logs "${NAME}" || true
  exit 1
fi

if docker exec --user 1000:1000 "${NAME}" node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const profile = JSON.parse(readFileSync("/data/dsh/profiles/web/package.json", "utf8"));
  const dependency = Boolean(profile.dependencies?.["dsh-yimu-bill"]);
  const bundle = Array.isArray(profile.dsh?.profile?.bundles) && profile.dsh.profile.bundles.includes("dsh-yimu-bill");
  if (!dependency || !bundle) {
    throw new Error(`dependency=${dependency} bundle=${bundle}`);
  }
  console.log("profile carries dsh-yimu-bill as dependency and bundle");
'; then
  pass 'the profile registers the plugin as a bundle'
else
  fail 'the installed plugin is missing from the profile dependencies or bundles'
  exit 1
fi

# profile 的 bundle 在进程启动时扫描；重启后新插件才会挂到 DSH Web 上。
docker restart "${NAME}" >/dev/null
if wait_health; then
  pass '/healthz answers after the plugin is loaded'
else
  fail 'the image did not become healthy after installing the plugin'
  exit 1
fi

JAR="${WORKDIR}/cookies.txt"
ROOT_HEADERS="${WORKDIR}/root.headers"
ROOT_CODE="$(curl --silent --show-error --user "dsh:${PASSWORD}" --cookie-jar "${JAR}" \
  --dump-header "${ROOT_HEADERS}" --output /dev/null --write-out '%{http_code}' \
  --max-time 5 "http://127.0.0.1:${PORT}/" || true)"
if [[ "${ROOT_CODE}" == "303" ]]; then
  pass 'the password gate bootstraps a DSH session (303)'
else
  fail "the password gate answered ${ROOT_CODE:-nothing}, expected 303"
fi
if grep --quiet --ignore-case --extended-regexp '^set-cookie: *dsh-auth-' "${ROOT_HEADERS}"; then
  pass 'the bootstrap minted a dsh-auth cookie'
else
  fail 'no dsh-auth cookie was minted'
fi

STATUS_CODE="$(curl --silent --show-error --cookie "${JAR}" --output "${WORKDIR}/status.json" \
  --write-out '%{http_code}' --max-time 10 "http://127.0.0.1:${PORT}/api/yimu-bill/status" || true)"
if [[ "${STATUS_CODE}" == "200" ]] && grep --quiet '"ok":true' "${WORKDIR}/status.json"; then
  pass '/api/yimu-bill/status is served by the plugin (200 ok)'
else
  fail "/api/yimu-bill/status answered ${STATUS_CODE:-nothing}: $(head -c 300 "${WORKDIR}/status.json" 2>/dev/null || true)"
fi
if grep --quiet '"configured":' "${WORKDIR}/status.json"; then
  pass 'the status payload carries the login state'
else
  fail 'the status payload does not look like the plugin response'
fi

# 真实的扫码会话：验证插件在发布镜像里仍能解析一木云端信封、生成二维码。
LOGIN_CODE="$(curl --silent --show-error --cookie "${JAR}" \
  --header 'content-type: application/json' --data '{}' \
  --output "${WORKDIR}/login.json" --write-out '%{http_code}' --max-time 30 \
  "http://127.0.0.1:${PORT}/api/yimu-bill/login/start" || true)"
if [[ "${LOGIN_CODE}" == "200" ]]; then
  pass '/api/yimu-bill/login/start answered 200'
else
  fail "/api/yimu-bill/login/start answered ${LOGIN_CODE:-nothing}: $(head -c 300 "${WORKDIR}/login.json" 2>/dev/null || true)"
fi
if grep --quiet '"sessionId":"' "${WORKDIR}/login.json" && grep --quiet '"qr":"data:image/png;base64,' "${WORKDIR}/login.json"; then
  pass 'the live scan-login API returned a session and a QR PNG'
else
  fail 'the live scan-login response is missing sessionId or qr PNG'
fi

if [[ "${FAILURES}" -ne 0 ]]; then
  printf '\n%s check(s) failed; container log follows\n' "${FAILURES}"
  docker logs "${NAME}" || true
  exit 1
fi

printf '\nimage %s (dsh %s, revision %s) is compatible with the packed plugin\n' \
  "${IMAGE}" "${IMAGE_DSH_VERSION:-unknown}" "${IMAGE_REVISION:-unknown}"
