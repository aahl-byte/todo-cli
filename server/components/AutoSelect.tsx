"use client";
// A select that submits its form on change.
export function AutoSelect({ name, value, options, label }: {
  name: string;
  value: string;
  options: { value: string; label: string }[];
  label: string;
}) {
  return (
    <select name={name} defaultValue={value} aria-label={label}
            onChange={(e) => e.currentTarget.form?.requestSubmit()}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
