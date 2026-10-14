import { cache } from "react";
import { cookies } from "next/headers";
import { db } from "./db";
import { DISPLAY_COOKIE, displayFor } from "./display";

/** This request's display of the project, from its cookie; once per request however many segments ask. */
export const currentDisplay = cache(async (project: string) =>
  displayFor(await db(), project, (await cookies()).get(DISPLAY_COOKIE)?.value));
