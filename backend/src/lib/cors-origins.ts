type CorsEnv = {
  FRONTEND_URL: string;
  CORS_ALLOWED_ORIGINS?: string;
};

export function parseCorsOrigins(env: CorsEnv): string[] {
  const list = (env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return list.length > 0 ? list : [env.FRONTEND_URL];
}
