/**
 * 二维码生成与渲染。
 *
 * 只依赖 qrcode-generator；终端文本渲染已移除，GUI 与测试都用统一的矩阵。
 *
 * @module dsh-yimu-bill/lib/qr
 */

import { createRequire } from 'node:module'

const QRCODE = createRequire(import.meta.url)('qrcode-generator')

/** 生成二维码矩阵（自动选版本，优先 M 级纠错）。 */
function makeQr(text) {
  const levels = ['M', 'L']
  for (const level of levels) {
    try {
      const qr = QRCODE(0, level)
      qr.addData(text)
      qr.make()
      return qr
    } catch {
      // 换更低纠错级别重试
    }
  }
  for (let type = 1; type <= 25; type += 1) {
    try {
      const qr = QRCODE(type, 'L')
      qr.addData(text)
      qr.make()
      return qr
    } catch {
      // 继续放大版本
    }
  }
  throw new Error('二维码生成失败（内容过长）')
}

/**
 * 返回含静区的布尔矩阵。
 * @param {string} text 二维码内容。
 * @param {number} [quiet] 静区模块数。
 * @returns {{size: number, rows: boolean[][]}}
 */
export function qrMatrix(text, quiet = 4) {
  const qr = makeQr(text)
  const count = qr.getModuleCount()
  const size = count + quiet * 2
  const rows = Array.from({ length: size }, () => Array(size).fill(false))
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) rows[row + quiet][col + quiet] = true
    }
  }
  return { size, rows }
}

/**
 * 生成二维码 SVG（单个 path，体积小于逐模块 rect）。
 * @param {string} text 二维码内容。
 * @param {number} [quiet] 静区模块数。
 * @returns {string}
 */
export function renderQrSvg(text, quiet = 4) {
  const { size, rows } = qrMatrix(text, quiet)
  const segments = []
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (rows[row][col]) segments.push(`M${col} ${row}h1v1h-1z`)
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${segments.join('')}" fill="#000"/></svg>`
}

/**
 * 二维码内容转 data URL（浏览器用 `<img>` 渲染，不注入 HTML）。
 * @param {string} text 二维码内容。
 * @returns {string}
 */
export function qrDataUrl(text) {
  return `data:image/svg+xml;base64,${Buffer.from(renderQrSvg(text), 'utf8').toString('base64')}`
}
