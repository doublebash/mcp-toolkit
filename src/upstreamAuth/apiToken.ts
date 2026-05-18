export interface ApiTokenHeaderOptions {
  /** Header name. Default 'Authorization'. */
  headerName?: string;
  /** Optional prefix. Default 'Bearer '. */
  prefix?: string;
}

export function apiTokenHeader(token: string, options: ApiTokenHeaderOptions = {}): Record<string, string> {
  const headerName = options.headerName ?? "Authorization";
  const prefix = options.prefix ?? "Bearer ";
  return { [headerName]: `${prefix}${token}` };
}
