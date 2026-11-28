import {
  BunestFactory,
  Injectable,
  NotFoundException,
  defineRoutes,
  type BunestApplication,
} from "@bunest/core";
import { DocumentBuilder, SwaggerModule } from "@bunest/swagger";
import { s } from "@bunest/validation/schema";

const ShortenBodySchema = s.object({
  url: s.string().url(),
  customCode: s.string().min(3).max(20).optional(),
});

const LinkSchema = s.object({
  code: s.string(),
  url: s.string().url(),
  hits: s.number(),
});

@Injectable()
export class ShortenerService {
  private readonly links = new Map<string, { code: string; url: string; hits: number }>();
  private seq = 1;

  shorten(url: string, customCode?: string) {
    const code = customCode ?? `b${this.seq++}`;
    const entry = { code, url, hits: 0 };
    this.links.set(code, entry);
    return entry;
  }

  resolve(code: string) {
    const entry = this.links.get(code);
    if (!entry) {
      throw new NotFoundException(`Short code "${code}" not found`);
    }
    entry.hits += 1;
    return { ...entry };
  }

  list() {
    return [...this.links.values()];
  }
}

export const shortenerRoutes = defineRoutes(
  { prefix: "/links", tags: ["links"] },
  (r) => {
    r.get(
      "/",
      {
        summary: "List shortened links",
        responseSchema: s.array(LinkSchema),
      },
      ({ get }) => get(ShortenerService).list(),
    );

    r.post(
      "/",
      {
        summary: "Create a short link",
        httpCode: 201,
        bodySchema: ShortenBodySchema,
        responseSchema: LinkSchema,
      },
      ({ body, get }) =>
        get(ShortenerService).shorten(body.url, body.customCode),
    );

    r.get(
      "/:code",
      {
        summary: "Resolve a short link",
        paramsSchema: s.object({ code: s.string().min(1) }),
        responseSchema: LinkSchema,
      },
      ({ params, get }) => get(ShortenerService).resolve(params.code),
    );
  },
);

export async function createMinimalApp(): Promise<BunestApplication> {
  const app = await BunestFactory.createRoutes(shortenerRoutes, {
    providers: [ShortenerService],
    logger: false,
  });

  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("Bunest Minimal URL Shortener")
      .setVersion("1.0.0")
      .build(),
  );
  SwaggerModule.setup("/docs", app, doc);
  return app;
}
