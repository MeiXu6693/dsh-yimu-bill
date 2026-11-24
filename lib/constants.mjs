/**
 * 少量跨模块共享的常量。
 *
 * @module dsh-yimu-bill/lib/constants
 */

/** DSH 凭据引用名；控制半写入、工具半读取。 */
export const TOKEN_REF = 'YIMU_TOKEN'

/** 二维码默认有效期（毫秒）。 */
export const DEFAULT_LOGIN_TTL_MS = 120_000

/** 两次「开始扫码」之间的最小间隔。 */
export const START_INTERVAL_MS = 3_000

/** 两次「测试连接」之间的最小间隔。 */
export const PROBE_INTERVAL_MS = 5_000
