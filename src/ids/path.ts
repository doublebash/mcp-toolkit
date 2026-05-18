import { ToolError } from "../errors/ToolError.js";

export type IdValidator = (kind: string, value: string) => void;

export const ghlIdValidator: IdValidator = (kind, value) => {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    throw ToolError.validation(`invalid ${kind}`, `${kind} failed GHL pattern: ${value}`);
  }
};

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const uuidValidator: IdValidator = (kind, value) => {
  if (!UUID_REGEX.test(value)) {
    throw ToolError.validation(`invalid ${kind}`, `${kind} failed UUID pattern: ${value}`);
  }
};

export interface BuildPathOptions {
  idValidator: IdValidator;
}

export function buildPath(
  template: string,
  ids: Record<string, string>,
  options: BuildPathOptions,
): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = ids[key];
    if (value === undefined) {
      throw ToolError.validation(`missing path parameter`, `template ${template} missing ${key}`);
    }
    options.idValidator(key, value);
    return encodeURIComponent(value);
  });
}
