import { RequestForm } from "@/components/RequestForm";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { users } from "@/lib/views";

export default async function NewRequest({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  await requireUser();
  const people = (await users(await db())).map((u) => u.handle);
  return (
    <>
      <RequestForm project={key} users={people} uploads={!!process.env.BLOB_READ_WRITE_TOKEN} />
    </>
  );
}
