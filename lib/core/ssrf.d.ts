/**
 * SSRF 防护（参照 wilond/dsh-news 思路）：抓取目标必须是指向公网的 http/https URL。
 * 拒绝：非 http(s)、内嵌凭据、内网/保留地址字面 IP、`.local`/localhost 主机名；
 * 域名目标由 fetcher 在 DNS 解析后用 {@link ipRejectReason} 复查解析结果
 * （不 pin 连接——极致 TOCTOU 竞态仍在，属文档声明的边界）。
 */
/** 校验通过返回 null，被拒返回原因字符串。 */
export declare function ssrfRejectReason(rawUrl: string): string | null;
/** 对"已解析出的 IP 地址"分类（audit P3 加固）：fetcher 在 DNS 解析后复查用——
 *  URL 层校验只看得见字面量，域名解析到内网/保留段（DNS rebinding、split-DNS）由这里拦截。
 *  输入是裸地址（可带 IPv6 括号/zone id）。 */
export declare function ipRejectReason(address: string): string | null;
/** 抛出版：非法地址抛 Error（fetcher/service 调用点用）。 */
export declare function assertPublicUrl(rawUrl: string): void;
//# sourceMappingURL=ssrf.d.ts.map