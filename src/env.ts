import type { ComputeJobEnvelope } from "./domain/types";

export type Env = {
  ASSETS: Fetcher;
  SESSIONS: DurableObjectNamespace;
  COMPUTE_JOBS: DurableObjectNamespace;
  BEST_MOVE_JOBS_QUEUE: Queue<ComputeJobEnvelope>;
  EVAL_JOBS_QUEUE: Queue<ComputeJobEnvelope>;
  BOT_SERVICE_URL?: string;
  MODAL_BOT_TOKEN?: string;
  KRAKEN_MODEL_VERSION?: string;
  KRAKEN_MOVE_TIMEOUT_MS?: string;
};
