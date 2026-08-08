/**
 * @app/contracts — 前后端共享的 Zod DTO / schema
 *
 * P1 落地全量 schema，规格见 docs/05-agent-design.md §7。
 * 这里先定义所有下游都要用的基础枚举与严重度映射，避免各包各写一份。
 */
import { z } from 'zod';
export declare const SeveritySchema: z.ZodEnum<["INFO", "WARNING", "CRITICAL"]>;
export type Severity = z.infer<typeof SeveritySchema>;
export declare const OriginSchema: z.ZodEnum<["RULE_ENGINE", "ERC", "DRC", "AI", "MEASUREMENT", "VISION"]>;
export type Origin = z.infer<typeof OriginSchema>;
export declare const AgentIntentSchema: z.ZodEnum<["design_review", "measure_guide", "waveform_analyze", "fault_diagnose", "photo_analyze", "report_generate", "general_chat"]>;
export type AgentIntent = z.infer<typeof AgentIntentSchema>;
export declare const ScenarioSchema: z.ZodEnum<["normal", "gain_error", "clipping", "noisy", "no_response"]>;
export type Scenario = z.infer<typeof ScenarioSchema>;
/** docs/05 §5.3：枚举 severity 与 UI pill 的唯一映射 */
export declare const SEVERITY_UI: {
    readonly CRITICAL: {
        readonly label: "高风险";
        readonly tone: "red";
    };
    readonly WARNING: {
        readonly label: "中风险";
        readonly tone: "orange";
    };
    readonly INFO: {
        readonly label: "低风险";
        readonly tone: "slate";
    };
};
/** VisualFinding.severity 直接存中文，'正常' 不对应任何 DiagnosisSeverity */
export declare const VISUAL_SEVERITIES: readonly ["高风险", "中风险", "低风险", "正常"];
export type VisualSeverity = (typeof VISUAL_SEVERITIES)[number];
export declare const HealthResponseSchema: z.ZodObject<{
    status: z.ZodLiteral<"ok">;
    service: z.ZodString;
    version: z.ZodString;
    mockMode: z.ZodBoolean;
    timestamp: z.ZodString;
}, "strip", z.ZodTypeAny, {
    status: "ok";
    service: string;
    version: string;
    mockMode: boolean;
    timestamp: string;
}, {
    status: "ok";
    service: string;
    version: string;
    mockMode: boolean;
    timestamp: string;
}>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
//# sourceMappingURL=index.d.ts.map