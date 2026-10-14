import { RequestForm } from "@/components/RequestForm";
import { db } from "@/lib/db";
import { filesEnabled } from "@/lib/files";
import { requireUser } from "@/lib/session";
import { choices, users } from "@/lib/views";

export default async function NewRequest({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  await requireUser();
  const d = await db();
  const people = (await users(d)).map((u) => u.handle);
  return (
    <>
      <RequestForm project={key} users={people} uploads={filesEnabled() ? { project: key, scope: "new" } : null} apps={await choices(d, key)} />
    </>
  );
}
