import { correctScenarios } from './correct.js';
import { recordScenarios } from './record.js';
import { surfaceScenarios } from './surface.js';
import { withholdScenarios } from './withhold.js';
import type { CompanionScenario } from '../types.js';

export const SCENARIOS: CompanionScenario[] = [
  ...recordScenarios,
  ...surfaceScenarios,
  ...withholdScenarios,
  ...correctScenarios,
];
