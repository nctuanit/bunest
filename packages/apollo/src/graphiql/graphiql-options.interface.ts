/**
 * Configuration options for the embedded GraphiQL playground HTML.
 */
export interface GraphiQLOptions {
  url?: string;
  /**
   * Static headers sent by GraphiQL.
   */
  headers?: Record<string, string>;
  /**
   * Toggle if the contents of the headers editor are persisted in storage.
   * @default true
   */
  shouldPersistHeaders?: boolean;
  /**
   * Toggle if the headers editor should be shown inside the editor tools.
   * @default true
   */
  isHeadersEditorEnabled?: boolean;
  /**
   * If `true`, the schema documentation includes deprecated input field and argument values.
   * @default false
   */
  inputValueDeprecation?: boolean;
}
