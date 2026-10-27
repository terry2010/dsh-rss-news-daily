/**
 * SSRF 防护（参照 wilond/dsh-news 思路）：抓取目标必须是指向公网的 http/https URL。
 * 拒绝：非 http(s)、内嵌凭据、内网/保留地址字面 IP、`.local`/localhost 主机名。
 * 说明：不做 DNS 解析后的地址复查（超出轻量插件范围，文档已声明边界）。
 */

const PRIVATE_HOSTNAMES = new Set(['localhost', 'localhost.localdomain'])

const PRIVATE_HOST_RE = /\.(local|lan|internal|intranet|home|corp)$/i

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // multicast/reserved/broadcast
  return false
}

/** 把 IPv6 文本里可能嵌入的 IPv4（v4-mapped ::ffff:x、NAT64 64:ff9b::/96）解码成点分串 */
function embeddedIpv4(h: string): string | null {
  let m = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (m) return m[1]
  // WHATWG URL 把 ::ffff:127.0.0.1 规范化成 ::ffff:7f00:1（两 16 位组）
  m = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16)
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  }
  // NAT64 知名前缀 64:ff9b::/96（后 32 位为 IPv4，可为点分或两组 hex）
  m = h.match(/^64:ff9b::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i)
  if (m) return m[1]
  m = h.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16)
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  }
  return null
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true
  const v4 = embeddedIpv4(h)
  return v4 !== null && isPrivateIpv4(v4)
}

/** 校验通过返回 null，被拒返回原因字符串。 */
export function ssrfRejectReason(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return 'URL 无法解析'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `协议不允许: ${url.protocol}`
  }
  if (url.username || url.password) return 'URL 不允许内嵌凭据'
  const host = url.hostname.toLowerCase().replace(/\.+$/, '') // 尾点(可多枚) FQDN 归一
  if (PRIVATE_HOSTNAMES.has(host) || PRIVATE_HOST_RE.test(host)) return `内网主机名: ${host}`
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) return `内网/保留 IP: ${host}`
  return null
}

/** 抛出版：非法地址抛 Error（fetcher/service 调用点用）。 */
export function assertPublicUrl(rawUrl: string): void {
  const reason = ssrfRejectReason(rawUrl)
  if (reason) throw new Error(`SSRF blocked: ${reason}`)
}
