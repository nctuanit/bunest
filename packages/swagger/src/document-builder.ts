import type {
  ApiResponseOptions,
  ExtensionLocation,
  OpenApiExternalDocs,
  OpenApiSecurityRequirement,
  OpenApiSecurityScheme,
  OpenApiServer,
  OpenApiServerVariable,
  OpenApiTag,
  ParameterObject,
  SwaggerConfig,
} from "./interfaces/openapi.interface";

export interface DocumentBuilderExtras {
  readonly globalParameters: ReadonlyArray<
    Omit<ParameterObject, "example" | "examples">
  >;
  readonly globalResponses: readonly ApiResponseOptions[];
  readonly basePath?: string;
}

const configExtrasMap = new WeakMap<object, DocumentBuilderExtras>();

/**
 * Reads global parameters / global responses attached to a `DocumentBuilder.build()` config.
 */
export function getDocumentBuilderExtras(
  config: object,
): DocumentBuilderExtras | undefined {
  return configExtrasMap.get(config);
}

/**
 * Fluent OpenAPI 3.1 document configuration builder.
 */
export class DocumentBuilder {
  private readonly doc: SwaggerConfig = {
    openapi: "3.1.0",
    info: {
      title: "Bunest API",
      version: "1.0.0",
    },
    servers: [],
    tags: [],
    components: {
      securitySchemes: {},
    },
  };

  private readonly rootExtensions: Record<string, unknown> = {};
  private readonly infoExtensions: Record<string, unknown> = {};
  private globalParameters: Array<
    Omit<ParameterObject, "example" | "examples">
  > = [];
  private globalResponses: ApiResponseOptions[] = [];
  private basePath?: string;

  setTitle(title: string): this {
    this.doc.info.title = title;
    return this;
  }

  setDescription(description: string): this {
    this.doc.info.description = description;
    return this;
  }

  setVersion(version: string): this {
    this.doc.info.version = version;
    return this;
  }

  setTermsOfService(termsOfService: string): this {
    this.doc.info.termsOfService = termsOfService;
    return this;
  }

  setContact(name: string, url?: string, email?: string): this {
    this.doc.info.contact = {
      name,
      ...(url !== undefined ? { url } : {}),
      ...(email !== undefined ? { email } : {}),
    };
    return this;
  }

  setLicense(name: string, url?: string): this {
    this.doc.info.license = {
      name,
      ...(url !== undefined ? { url } : {}),
    };
    return this;
  }

  setOpenAPIVersion(version: string): this {
    if (/^\d+\.\d+\.\d+$/.test(version)) {
      this.doc.openapi = version;
    }
    return this;
  }

  setExternalDoc(description: string, url: string): this {
    this.doc.externalDocs = { description, url };
    return this;
  }

  /**
   * @deprecated Global prefixes are populated automatically; use `addServer()` instead.
   */
  setBasePath(path: string): this {
    this.basePath = path;
    return this;
  }

  addServer(
    url: string,
    description?: string,
    variables?: Record<string, OpenApiServerVariable>,
    serverExtraProperties?: Record<string, any>,
  ): this {
    const server: OpenApiServer = {
      url,
      ...(description !== undefined ? { description } : {}),
      ...(variables !== undefined ? { variables } : {}),
    };
    if (serverExtraProperties) {
      for (const [k, v] of Object.entries(serverExtraProperties)) {
        if (k !== "url" && k !== "description" && k !== "variables") {
          server[k] = v;
        }
      }
    }
    this.doc.servers = [...(this.doc.servers ?? []), server];
    return this;
  }

  addTag(
    name: string,
    description?: string,
    externalDocs?: OpenApiExternalDocs,
    options?: {
      summary?: string;
      parent?: string;
      kind?: string;
    },
  ): this {
    const tag: OpenApiTag = {
      name,
      ...(options?.summary !== undefined ? { summary: options.summary } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(externalDocs !== undefined ? { externalDocs } : {}),
      ...(options?.parent !== undefined ? { parent: options.parent } : {}),
      ...(options?.kind !== undefined ? { kind: options.kind } : {}),
    };
    this.doc.tags = [...(this.doc.tags ?? []), tag];
    return this;
  }

  addExtension(
    extensionKey: string,
    extensionProperties: any,
    location: ExtensionLocation = "root",
  ): this {
    if (!extensionKey.startsWith("x-")) {
      throw new Error(
        `Extension key "${extensionKey}" is not prefixed. Please ensure you prefix it with "x-".`,
      );
    }
    const cloned =
      extensionProperties !== null && typeof extensionProperties === "object"
        ? structuredClone(extensionProperties)
        : extensionProperties;
    if (location === "info") {
      this.infoExtensions[extensionKey] = cloned;
    } else {
      this.rootExtensions[extensionKey] = cloned;
    }
    return this;
  }

  addSecurity(name: string, options: OpenApiSecurityScheme): this {
    this.doc.components = this.doc.components ?? {};
    this.doc.components.securitySchemes = {
      ...(this.doc.components.securitySchemes ?? {}),
      [name]: { ...options },
    };
    return this;
  }

  addGlobalParameters(
    ...parameters: Omit<ParameterObject, "example" | "examples">[]
  ): this {
    this.globalParameters = [
      ...this.globalParameters,
      ...parameters.map((p) => ({ ...p })),
    ];
    return this;
  }

  addGlobalResponse(...responses: ApiResponseOptions[]): this {
    this.globalResponses = [
      ...this.globalResponses,
      ...responses.map((r) => ({ ...r })),
    ];
    return this;
  }

  addSecurityRequirements(
    name: string | OpenApiSecurityRequirement,
    requirements: string[] = [],
  ): this {
    const req: OpenApiSecurityRequirement =
      typeof name === "string" ? { [name]: [...requirements] } : { ...name };
    this.doc.security = [...(this.doc.security ?? []), req];
    return this;
  }

  addGlobalSecurity(
    name: string | OpenApiSecurityRequirement,
    scopes: string[] = [],
  ): this {
    return this.addSecurityRequirements(name, scopes);
  }

  addBearerAuth(
    options: Partial<OpenApiSecurityScheme> = {},
    name = "bearer",
  ): this {
    return this.addSecurity(name, {
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
      ...options,
    });
  }

  addOAuth2(
    options: Partial<OpenApiSecurityScheme> = {},
    name = "oauth2",
  ): this {
    return this.addSecurity(name, {
      type: "oauth2",
      flows: {},
      ...options,
    });
  }

  addBasicAuth(
    options: Partial<OpenApiSecurityScheme> = {},
    name = "basic",
  ): this {
    return this.addSecurity(name, {
      type: "http",
      scheme: "basic",
      ...options,
    });
  }

  addApiKey(
    options: Partial<OpenApiSecurityScheme> = {},
    name = "api-key",
  ): this {
    return this.addSecurity(name, {
      type: "apiKey",
      in: "header",
      name: options.name ?? "X-API-Key",
      ...options,
    });
  }

  addCookieAuth(
    cookieName = "connect.sid",
    options: Partial<OpenApiSecurityScheme> = {},
    securityName = "cookie",
  ): this {
    return this.addSecurity(securityName, {
      type: "apiKey",
      in: "cookie",
      name: cookieName,
      ...options,
    });
  }

  build(): SwaggerConfig {
    const result: SwaggerConfig = {
      openapi: this.doc.openapi,
      info: {
        ...this.doc.info,
        ...this.infoExtensions,
      },
      ...this.rootExtensions,
    };

    if (this.doc.servers && this.doc.servers.length > 0) {
      result.servers = this.doc.servers.map((s) => ({ ...s }));
    }
    if (this.doc.tags && this.doc.tags.length > 0) {
      result.tags = this.doc.tags.map((t) => ({ ...t }));
    }
    if (this.doc.externalDocs) {
      result.externalDocs = { ...this.doc.externalDocs };
    }
    if (this.doc.security && this.doc.security.length > 0) {
      result.security = this.doc.security.map((s) => ({ ...s }));
    }
    const schemes = this.doc.components?.securitySchemes;
    if (schemes && Object.keys(schemes).length > 0) {
      result.components = {
        securitySchemes: { ...schemes },
      };
    }

    if (
      this.globalParameters.length > 0 ||
      this.globalResponses.length > 0 ||
      this.basePath !== undefined
    ) {
      configExtrasMap.set(result, {
        globalParameters: this.globalParameters.map((p) => ({ ...p })),
        globalResponses: this.globalResponses.map((r) => ({ ...r })),
        basePath: this.basePath,
      });
    }

    return result;
  }
}
