import React from "react";
import { PlayfulSelect } from "./PlayfulSelect";
import type { CollectionShareRole } from "../types";

const ROLE_OPTIONS: {
  label: string;
  value: CollectionShareRole;
  danger?: boolean;
}[] = [
  { label: "Viewer", value: "view" },
  { label: "Editor", value: "edit" },
];

export const RoleSelect: React.FC<{
  value: CollectionShareRole;
  onChange: (val: string) => void;
  extraOptions?: { label: string; value: string; danger?: boolean }[];
}> = ({ value, onChange, extraOptions = [] }) => {
  const options = [...ROLE_OPTIONS, ...extraOptions];
  return (
    <PlayfulSelect
      ariaLabel="Collection access"
      value={value}
      onChange={onChange}
      options={options}
      align="right"
      portal
    />
  );
};
