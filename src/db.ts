import postgres from "postgres";

export const db = postgres({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "54322"),
  database: process.env.DB_NAME || "postgres",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  max: 20,
});

export type DbClient = Parameters<Parameters<typeof db.begin>[0]>[0];

export async function withAuthContext<T>(userId: string, fn: (sql: DbClient) => Promise<T>): Promise<T> {
  return db.begin(async (sql) => {
    await sql`SELECT set_config('request.jwt.claim.sub', ${userId}, true)`.execute();
    await sql`SELECT set_config('request.jwt.claim.role', 'authenticated', true)`.execute();
    await sql`SET LOCAL ROLE authenticated`.execute();
    return fn(sql);
  });
}
