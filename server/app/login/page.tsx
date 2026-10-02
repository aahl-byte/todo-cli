import { LoginForm } from "@/components/LoginForm";

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main>
      <h1>Sign in to todo</h1>
      <LoginForm next={next && next.startsWith("/") ? next : "/"} />
    </main>
  );
}
