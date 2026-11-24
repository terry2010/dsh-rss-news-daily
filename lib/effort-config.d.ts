import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
export type EffortProbeResult = {
    kind: 'has-efforts';
} | {
    kind: 'no-reasoning';
} | {
    kind: 'written';
    file: string;
    api: string;
} | {
    kind: 'exists';
} | {
    kind: 'unsupported';
    detail: string;
} | {
    kind: 'probe-failed';
    detail: string;
};
/** 定位 cordis.patch.yml 候选（去重、有序）：
 *  1. 本包安装路径向上逐级收集全部命中——npm 布局 profiles/<p>/node_modules/<pkg>/lib/
 *     下，运行中 profile 的 patch 是模块路径祖先，必被命中且排在其他 profile 之前。
 *     注意不能在首个命中处停：包自带的 cordis.patch.yml（bundle patch，无 llm-pi-ai
 *     条目）总是最先命中，早退会让后面的 profile 扫描成为死代码。
 *  2. 扫 DSH_HOME/profiles/* 补 dev(file: 安装 realpath 丢失 profile 祖先）/非常规布局。
 *  调用方逐份尝试 patchCordisText——哪份含目标模型块写哪份，找不到块的不动。 */
export declare function cordisFiles(opts?: {
    fromDir?: string;
    dshHome?: string;
}): Promise<string[]>;
/** 对一份 patch 文本尝试生成并插入 effort 块。导出供测试：纯文本手术，不碰文件系统。 */
export declare function patchCordisText(text: string, provider: string, model: string): {
    text?: string;
    api?: string;
    exists?: boolean;
    reason?: string;
};
/** 主流程：探测翻译路由，必要时写 cordis.patch.yml。 */
export declare function ensureEffortConfig(llm: LlmRuntime, resolved: {
    provider: string;
    model: string;
}): Promise<EffortProbeResult>;
//# sourceMappingURL=effort-config.d.ts.map