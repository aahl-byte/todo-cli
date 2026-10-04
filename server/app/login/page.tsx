import { LoginForm } from "@/components/LoginForm";
import { safeNext } from "@/lib/action-helpers";

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main>
      <h1 className="brand" style={{ margin: "40px 0 16px" }}>todo</h1>
      <LoginForm next={safeNext(next ?? "/")} />
    </main>
  );
}
