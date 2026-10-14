"use client";
// A page that shows everything and changes nothing: a wall display. Controls
// that write check it and render as plain text, or not at all.
import { createContext, useContext } from "react";

export interface ReadOnlyView {
  /** Where links to items and files start, e.g. /display/web. */
  base: string;
}

export const ReadOnly = createContext<ReadOnlyView | null>(null);
export const useReadOnly = () => useContext(ReadOnly);
