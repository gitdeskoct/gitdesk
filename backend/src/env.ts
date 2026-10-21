export type AuthContext = { accountId: string; sessionId: string };

export type AppEnv = {
  Bindings: CloudflareBindings;
  Variables: { requestId: string; auth: AuthContext };
};
