"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HealthResponseSchema = exports.VISUAL_SEVERITIES = exports.SEVERITY_UI = exports.ScenarioSchema = exports.AgentIntentSchema = exports.OriginSchema = exports.SeveritySchema = void 0;
/**
 * @app/contracts — 前后端共享的 Zod DTO / schema
 *
 * P1 落地全量 schema，规格见 docs/05-agent-design.md §7。
 * 这里先定义所有下游都要用的基础枚举与严重度映射，避免各包各写一份。
 */
const zod_1 = require("zod");
exports.SeveritySchema = zod_1.z.enum(['INFO', 'WARNING', 'CRITICAL']);
exports.OriginSchema = zod_1.z.enum([
    'RULE_ENGINE',
    'ERC',
    'DRC',
    'AI',
    'MEASUREMENT',
    'VISION',
]);
exports.AgentIntentSchema = zod_1.z.enum([
    'design_review',
    'measure_guide',
    'waveform_analyze',
    'fault_diagnose',
    'photo_analyze',
    'report_generate',
    'general_chat',
]);
exports.ScenarioSchema = zod_1.z.enum([
    'normal',
    'gain_error',
    'clipping',
    'noisy',
    'no_response',
]);
/** docs/05 §5.3：枚举 severity 与 UI pill 的唯一映射 */
exports.SEVERITY_UI = {
    CRITICAL: { label: '高风险', tone: 'red' },
    WARNING: { label: '中风险', tone: 'orange' },
    INFO: { label: '低风险', tone: 'slate' },
};
/** VisualFinding.severity 直接存中文，'正常' 不对应任何 DiagnosisSeverity */
exports.VISUAL_SEVERITIES = ['高风险', '中风险', '低风险', '正常'];
exports.HealthResponseSchema = zod_1.z.object({
    status: zod_1.z.literal('ok'),
    service: zod_1.z.string(),
    version: zod_1.z.string(),
    mockMode: zod_1.z.boolean(),
    timestamp: zod_1.z.string(),
});
//# sourceMappingURL=index.js.map