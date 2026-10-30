import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { AgentBudgetError, AgentRelayError, type AiGateway } from '../ai/gateway.js';
import type { LegalClause } from '../../shared/types.js';
import { CrewRunStore, importedRun, runCrew, validateImportedRun } from './crew.js';

type Principal = { sub?: string; globalRole?: string } | undefined;
const principalOf = (res: express.Response) => res.locals.principal as Principal;
const isOperator = (p: Principal) => p?.globalRole === 'admin';

/**
 * The agent crew's endpoints, mounted behind the /api guard (which sets res.locals.principal):
 * - POST /api/agents/llm/v1/chat/completions: OpenAI-compatible chat completions for the Python
 *   crew (agents/). "model" is the agent id; the server picks that agent's configured model and
 *   key, enforces the agents' daily token budget and logs the call. Operator only
 *   (LEXCOMPILER_API_TOKEN, or loopback without sign-in).
 * - /api/agents/crew/runs: the six agents chained (crew.ts). Without models every step is a
 *   direct tool call; { "useModels": true } lets each agent's configured model report too, which
 *   spends the agents' daily budget, so only the operator may ask for it.
 */
export function createAgentRouter(deps: {
  db: DatabaseSync;
  gateway: () => AiGateway;
  clauses: () => LegalClause[];
  runCrew?: typeof runCrew;
}): express.Router {
  const router = express.Router();
  const crewRuns = new CrewRunStore(deps.db);
  const run = deps.runCrew ?? runCrew;

  router.post('/api/agents/llm/v1/chat/completions', async (req, res, next) => {
    if (!isOperator(principalOf(res))) {
      res.status(403).json({ error: { message: 'The agent model route is for the server operator (LEXCOMPILER_API_TOKEN).', type: 'permission_error' } });
      return;
    }
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      res.json(await deps.gateway().relayAgentChat(String(body.model || ''), body));
    } catch (err) {
      if (err instanceof AgentBudgetError || err instanceof AgentRelayError) {
        res.status(err.status).json({ error: { message: err.message, type: err instanceof AgentBudgetError ? 'budget_exceeded' : 'agent_route_error' } });
        return;
      }
      next(err);
    }
  });

  router.post('/api/agents/crew/runs', async (req, res, next) => {
    const principal = principalOf(res);
    const useModels = req.body?.useModels === true;
    if (useModels && !isOperator(principal)) {
      res.status(403).json({ error: 'Running the crew with models is for the server operator (LEXCOMPILER_API_TOKEN).' });
      return;
    }
    try {
      const result = await run(deps.clauses(), { useModels, triggeredBy: principal?.sub ?? null });
      crewRuns.save(result);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  /** A run of the Python crew (python -m lexcompiler_agents crew), stored as it reports it. Operator only. */
  router.post('/api/agents/crew/runs/import', (req, res) => {
    const principal = principalOf(res);
    if (!isOperator(principal)) {
      res.status(403).json({ error: 'Storing a Python crew run is for the server operator (LEXCOMPILER_API_TOKEN).' });
      return;
    }
    const problem = validateImportedRun(req.body);
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }
    const stored = importedRun(deps.db, req.body as Record<string, unknown>, principal?.sub ?? null);
    crewRuns.save(stored);
    res.status(201).json({ id: stored.id });
  });

  router.get('/api/agents/crew/runs', (_req, res) => {
    res.json({ runs: crewRuns.list() });
  });

  router.get('/api/agents/crew/runs/:id', (req, res) => {
    const found = crewRuns.get(req.params.id);
    if (!found) {
      res.status(404).json({ error: 'No such crew run.' });
      return;
    }
    res.json(found);
  });

  return router;
}
