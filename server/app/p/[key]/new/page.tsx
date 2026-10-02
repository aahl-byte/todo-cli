import { RequestForm } from "@/components/RequestForm";
import { db } from "@/lib/db";
import { users } from "@/lib/views";

export default async function NewRequest({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const people = (await users(await db())).map((u) => u.handle);
  return (
    <>
      <h1>New request</h1>
      <RequestForm project={key} users={people} uploads={!!process.env.BLOB_READ_WRITE_TOKEN} />
    </>
  );
}
