// Creates a tiny sample repo + policy for trying DevPilot end to end.
import { POLICY, makeRepo } from '../tests/helpers';
const env = makeRepo(POLICY.replace('agent_sandbox: false', 'agent_sandbox: true').replace('max_repair_attempts: 4', 'max_repair_attempts: 2').replace('gate_timeout_seconds: 60', 'gate_timeout_seconds: 120'));
console.log(JSON.stringify(env));
