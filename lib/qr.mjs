/**
 * 二维码 PNG 渲染（dsh-go 原生面板的 image 组件用）。
 *
 * @module dsh-yimu-bill/lib/qr
 */

import QRCode from 'qrcode'

/**
 * 二维码 PNG data URL。
 * @param {string} text 二维码内容。
 * @param {object} [options] qrcode 选项（width/margin 等）。
 * @returns {Promise<string>}
 */
export async function qrDataUrlPng(text, options = {}) {
  const buffer = await QRCode.toBuffer(text, { type: 'png', margin: 1, width: 320, ...options })
  return `data:image/png;base64,${buffer.toString('base64')}`
}
