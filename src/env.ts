export type Env = {
  ASSETS: Fetcher;
  SESSIONS: DurableObjectNamespace;
  MATCHMAKER: DurableObjectNamespace;
  KRAKEN_CONTAINER?: DurableObjectNamespace;
  BOT_SERVICE_URL?: string;
  KRAKEN_CONTAINER_POOL_SIZE?: string;
  KRAKEN_DEVICE?: string;
  KRAKEN_MODEL_PATH?: string;
  KRAKEN_MODEL_URL?: string;
  KRAKEN_MODEL_VERSION?: string;
  KRAKEN_N_SIMS?: string;
  KRAKEN_PYTHON_EXECUTABLE?: string;
  KRAKEN_TORCH_THREADS?: string;
  KRAKEN_BUILD_EXTENSIONS?: string;
};
