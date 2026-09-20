import { z } from 'zod';
export const StepKindSchema = z.enum([
    'goto', 'fill', 'click', 'hover', 'dblclick', 'rightclick', 'select', 'check',
    'uncheck', 'upload', 'scroll', 'wait', 'press', 'drag', 'mouse', 'expect',
]);
// Zod supplies literal-valued constants as well as the corresponding union type.
export const StepKind = StepKindSchema.enum;
