import { Select } from "@radix-ui/themes";
import type { Category } from "../../../../packages/shared-types";

export function FolderSelect({ categories, value, onChange, label, defaultLabel, disabled, id, size = "1" }: {
  categories: Category[];
  value: string;
  onChange(value: string): void;
  label: string;
  defaultLabel: string;
  disabled?: boolean;
  id?: string;
  size?: "1" | "2";
}) {
  return <Select.Root size={size} value={value} onValueChange={onChange} disabled={disabled}>
    <Select.Trigger id={id} aria-label={label} />
    <Select.Content>
      <Select.Item value="none">{defaultLabel}</Select.Item>
      {categories.filter(category => category.parentId === null).map(root => <Select.Group key={root.id}>
        <Select.Item value={root.id}>{root.name}</Select.Item>
        {categories.filter(category => category.parentId === root.id).map(child =>
          <Select.Item value={child.id} key={child.id}>{root.name} / {child.name}</Select.Item>
        )}
      </Select.Group>)}
    </Select.Content>
  </Select.Root>;
}
