/**
 * SSRF 防护（参照 wilond/dsh-news 思路）：抓取目标必须是指向公网的 http/https URL。
 * 拒绝：非 http(s)、内嵌凭据、内网/保留地址字面 IP、`.local`/localhost 主机名。
 * 说明：不做 DNS 解析后的地址复查（超出轻量插件范围，文档已声明边界）。
 */
/** 校验通过返回 null，被拒返回原因字符串。 */
export declare function ssrfRejectReason(rawUrl: string): string | null;
/** 抛出版：非法地址抛 Error（fetcher/service 调用点用）。 */
export declare function assertPublicUrl(rawUrl: string): void;
//# sourceMappingURL=ssrf.d.ts.map