import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Inject, Injectable, Module } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import {
  ELASTICSEARCH_MODULE_OPTIONS,
  ElasticsearchConnectionError,
  ElasticsearchModule,
  ElasticsearchResponseError,
  ElasticsearchService,
  ElasticsearchTimeoutError,
  parseCloudId,
  type ElasticsearchModuleOptions,
  type ElasticsearchOptionsFactory,
  type FetchLike,
} from "../src";

interface StoredIndex {
  settings: Record<string, any>;
  mappings: Record<string, any>;
  aliases: Set<string>;
  docs: Map<string, Record<string, any>>;
}

function createMockEsServer() {
  const indices = new Map<string, StoredIndex>();
  const pipelines = new Map<string, Record<string, any>>();
  const scrolls = new Map<string, { docs: any[]; offset: number; size: number }>();
  const receivedRequests: Array<{
    method: string;
    path: string;
    query: string;
    headers: Record<string, string>;
    rawBody: string;
  }> = [];
  let seq = 0;

  const json = (data: unknown, status = 200, extraHeaders?: Record<string, string>) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "content-type": "application/json",
        ...extraHeaders,
      },
    });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const method = req.method.toUpperCase();
      const pathname = url.pathname;
      const headersRecord: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headersRecord[k.toLowerCase()] = v;
      });

      let rawBody = "";
      if (method !== "GET" && method !== "HEAD") {
        if (headersRecord["content-encoding"] === "gzip") {
          const compressed = new Uint8Array(await req.arrayBuffer());
          rawBody = new TextDecoder().decode(Bun.gunzipSync(compressed));
        } else {
          rawBody = await req.text();
        }
      }

      receivedRequests.push({
        method,
        path: pathname,
        query: url.search,
        headers: headersRecord,
        rawBody,
      });

      // Simulated slow endpoint for timeout testing
      if (pathname === "/_slow") {
        await Bun.sleep(250);
        return json({ ok: true });
      }

      // Root ping / info
      if (pathname === "/") {
        if (method === "HEAD") {
          return new Response(null, { status: 200 });
        }
        return json({
          name: "bunest-es-node-1",
          cluster_name: "bunest-test-cluster",
          cluster_uuid: "uuid-1234",
          version: { number: "9.0.0", lucene_version: "10.0.0" },
          tagline: "You Know, for Search",
        });
      }

      // Cluster health
      if (pathname.startsWith("/_cluster/health")) {
        return json({
          cluster_name: "bunest-test-cluster",
          status: "green",
          number_of_nodes: 1,
          active_primary_shards: indices.size,
        });
      }

      // Cat indices
      if (pathname.startsWith("/_cat/indices")) {
        const list = [...indices.entries()].map(([name, idx]) => ({
          index: name,
          health: "green",
          status: "open",
          "docs.count": String(idx.docs.size),
        }));
        return json(list);
      }

      // Ingest pipeline CRUD
      if (pathname.startsWith("/_ingest/pipeline/")) {
        const id = decodeURIComponent(pathname.slice("/_ingest/pipeline/".length));
        if (method === "PUT") {
          pipelines.set(id, JSON.parse(rawBody || "{}"));
          return json({ acknowledged: true });
        }
        if (method === "GET") {
          const p = pipelines.get(id);
          if (!p) return json({ error: { type: "resource_not_found_exception", reason: "pipeline not found" } }, 404);
          return json({ [id]: p });
        }
        if (method === "DELETE") {
          pipelines.delete(id);
          return json({ acknowledged: true });
        }
      }

      // Bulk (root or index-scoped)
      if (pathname === "/_bulk" || pathname.endsWith("/_bulk")) {
        const defaultIdx =
          pathname === "/_bulk"
            ? undefined
            : decodeURIComponent(pathname.slice(1, pathname.length - "/_bulk".length));
        const lines = rawBody.split("\n").filter((l) => l.trim().length > 0);
        const items: any[] = [];
        for (let i = 0; i < lines.length; i++) {
          const actionObj = JSON.parse(lines[i]!);
          const action = Object.keys(actionObj)[0]!;
          const meta = actionObj[action] ?? {};
          const idxName = meta._index ?? defaultIdx ?? "default";
          let idx = indices.get(idxName);
          if (!idx) {
            idx = { settings: {}, mappings: {}, aliases: new Set(), docs: new Map() };
            indices.set(idxName, idx);
          }
          if (action === "index" || action === "create") {
            const doc = JSON.parse(lines[++i]!);
            const id = meta._id ?? `auto-${++seq}`;
            idx.docs.set(id, doc);
            items.push({ [action]: { _index: idxName, _id: id, status: 201, result: "created" } });
          } else if (action === "delete") {
            idx.docs.delete(meta._id);
            items.push({ delete: { _index: idxName, _id: meta._id, status: 200, result: "deleted" } });
          }
        }
        return json({ took: 2, errors: false, items });
      }

      // Scroll continuation / clear
      if (pathname === "/_search/scroll" || pathname === "/_search/scroll/_all") {
        if (method === "DELETE") {
          const body = rawBody ? JSON.parse(rawBody) : {};
          if (body.scroll_id) {
            const ids = Array.isArray(body.scroll_id) ? body.scroll_id : [body.scroll_id];
            for (const sid of ids) scrolls.delete(sid);
            return json({ succeeded: true, num_freed: ids.length });
          }
          const freed = scrolls.size;
          scrolls.clear();
          return json({ succeeded: true, num_freed: freed });
        }
        if (method === "POST") {
          const body = JSON.parse(rawBody);
          const state = scrolls.get(body.scroll_id);
          if (!state) {
            return json({ error: { type: "search_context_missing_exception", reason: "No search context" } }, 404);
          }
          const slice = state.docs.slice(state.offset, state.offset + state.size);
          state.offset += slice.length;
          return json({
            _scroll_id: body.scroll_id,
            took: 1,
            timed_out: false,
            _shards: { total: 1, successful: 1, failed: 0 },
            hits: {
              total: { value: state.docs.length, relation: "eq" },
              hits: slice,
            },
          });
        }
      }

      // Close PIT
      if (pathname === "/_pit" && method === "DELETE") {
        return json({ succeeded: true, num_freed: 1 });
      }

      // Mget
      if (pathname === "/_mget" || pathname.endsWith("/_mget")) {
        const defaultIdx =
          pathname === "/_mget"
            ? undefined
            : decodeURIComponent(pathname.slice(1, pathname.length - "/_mget".length));
        const body = JSON.parse(rawBody || "{}");
        const requests: Array<{ _index: string; _id: string }> = body.docs
          ? body.docs.map((d: any) => ({ _index: d._index ?? defaultIdx!, _id: d._id }))
          : (body.ids ?? []).map((id: string) => ({ _index: defaultIdx!, _id: id }));
        const docs = requests.map(({ _index, _id }) => {
          const doc = indices.get(_index)?.docs.get(_id);
          return doc
            ? { _index, _id, found: true, _source: doc }
            : { _index, _id, found: false };
        });
        return json({ docs });
      }

      // Msearch
      if (pathname === "/_msearch" || pathname.endsWith("/_msearch")) {
        const defaultIdx =
          pathname === "/_msearch"
            ? undefined
            : decodeURIComponent(pathname.slice(1, pathname.length - "/_msearch".length));
        const lines = rawBody.split("\n").filter((l) => l.trim().length > 0);
        const responses: any[] = [];
        for (let i = 0; i < lines.length; i += 2) {
          const header = JSON.parse(lines[i]!);
          const idxName = header.index ?? defaultIdx!;
          const idx = indices.get(idxName);
          const hits = idx
            ? [...idx.docs.entries()].map(([_id, _source]) => ({
                _index: idxName,
                _id,
                _score: 1.0,
                _source,
              }))
            : [];
          responses.push({
            took: 1,
            timed_out: false,
            _shards: { total: 1, successful: 1, failed: 0 },
            hits: { total: { value: hits.length, relation: "eq" }, hits },
          });
        }
        return json({ took: 2, responses });
      }

      // Index-scoped operations: /<index>/...
      const parts = pathname.split("/").filter(Boolean);
      const indexName = decodeURIComponent(parts[0] ?? "");
      const op = parts[1];
      const docId = parts[2] ? decodeURIComponent(parts[2]) : undefined;

      // Index management: /<index>
      if (parts.length === 1 && indexName && !indexName.startsWith("_")) {
        if (method === "HEAD") {
          return new Response(null, { status: indices.has(indexName) ? 200 : 404 });
        }
        if (method === "PUT") {
          const body = rawBody ? JSON.parse(rawBody) : {};
          indices.set(indexName, {
            settings: body.settings ?? {},
            mappings: body.mappings ?? {},
            aliases: new Set(Object.keys(body.aliases ?? {})),
            docs: new Map(),
          });
          return json({ acknowledged: true, shards_acknowledged: true, index: indexName });
        }
        if (method === "GET") {
          const idx = indices.get(indexName);
          if (!idx) return json({ error: { type: "index_not_found_exception", reason: "no such index" } }, 404);
          return json({ [indexName]: { settings: idx.settings, mappings: idx.mappings } });
        }
        if (method === "DELETE") {
          const existed = indices.delete(indexName);
          if (!existed) return json({ error: { type: "index_not_found_exception", reason: "no such index" } }, 404);
          return json({ acknowledged: true });
        }
      }

      // /<index>/_pit
      if (op === "_pit" && method === "POST") {
        return json({ id: `pit-${indexName}-${++seq}` });
      }

      // /<index>/_refresh
      if (op === "_refresh") {
        return json({ _shards: { total: 1, successful: 1, failed: 0 } });
      }

      // /<index>/_mapping
      if (op === "_mapping") {
        const idx = indices.get(indexName);
        if (!idx) return json({ error: { reason: "index not found" } }, 404);
        if (method === "PUT") {
          idx.mappings = { ...idx.mappings, ...JSON.parse(rawBody || "{}") };
          return json({ acknowledged: true });
        }
        return json({ [indexName]: { mappings: idx.mappings } });
      }

      // /<index>/_alias/<name>
      if (op === "_alias" && docId) {
        const idx = indices.get(indexName);
        if (!idx) return json({ error: { reason: "index not found" } }, 404);
        if (method === "PUT") {
          idx.aliases.add(docId);
          return json({ acknowledged: true });
        }
        if (method === "HEAD") {
          return new Response(null, { status: idx.aliases.has(docId) ? 200 : 404 });
        }
        if (method === "DELETE") {
          idx.aliases.delete(docId);
          return json({ acknowledged: true });
        }
      }

      // /<index>/_doc[/<id>] or /<index>/_create/<id>
      if (op === "_doc" || op === "_create") {
        let idx = indices.get(indexName);
        if (!idx && (method === "PUT" || method === "POST")) {
          idx = { settings: {}, mappings: {}, aliases: new Set(), docs: new Map() };
          indices.set(indexName, idx);
        }
        if (!idx) {
          return method === "HEAD"
            ? new Response(null, { status: 404 })
            : json({ error: { type: "index_not_found_exception", reason: "no such index" } }, 404);
        }
        if (method === "HEAD" && docId) {
          return new Response(null, { status: idx.docs.has(docId) ? 200 : 404 });
        }
        if (method === "GET" && docId) {
          const doc = idx.docs.get(docId);
          if (!doc) {
            return json({ _index: indexName, _id: docId, found: false }, 404);
          }
          return json({ _index: indexName, _id: docId, _version: 1, found: true, _source: doc });
        }
        if (method === "PUT" || method === "POST") {
          const id = docId ?? `doc-${++seq}`;
          const existed = idx.docs.has(id);
          if (op === "_create" && existed) {
            return json({ error: { type: "version_conflict_engine_exception", reason: "document already exists" } }, 409);
          }
          idx.docs.set(id, JSON.parse(rawBody || "{}"));
          return json(
            {
              _index: indexName,
              _id: id,
              _version: existed ? 2 : 1,
              result: existed ? "updated" : "created",
              _shards: { total: 1, successful: 1, failed: 0 },
              _seq_no: ++seq,
              _primary_term: 1,
            },
            existed ? 200 : 201,
          );
        }
        if (method === "DELETE" && docId) {
          const existed = idx.docs.delete(docId);
          if (!existed) {
            return json({ _index: indexName, _id: docId, result: "not_found" }, 404);
          }
          return json({
            _index: indexName,
            _id: docId,
            _version: 2,
            result: "deleted",
            _shards: { total: 1, successful: 1, failed: 0 },
            _seq_no: ++seq,
            _primary_term: 1,
          });
        }
      }

      // /<index>/_source/<id>
      if (op === "_source" && docId) {
        const doc = indices.get(indexName)?.docs.get(docId);
        if (method === "HEAD") {
          return new Response(null, { status: doc ? 200 : 404 });
        }
        if (!doc) return json({ error: { reason: "not found" } }, 404);
        return json(doc);
      }

      // /<index>/_update/<id>
      if (op === "_update" && docId && method === "POST") {
        const idx = indices.get(indexName);
        if (!idx) return json({ error: { reason: "index not found" } }, 404);
        const body = JSON.parse(rawBody || "{}");
        const existing = idx.docs.get(docId);
        if (!existing) {
          if (body.doc_as_upsert && body.doc) {
            idx.docs.set(docId, body.doc);
            return json({
              _index: indexName,
              _id: docId,
              _version: 1,
              result: "created",
              _shards: { total: 1, successful: 1, failed: 0 },
              _seq_no: ++seq,
              _primary_term: 1,
            });
          }
          return json({ error: { type: "document_missing_exception", reason: "document missing" } }, 404);
        }
        idx.docs.set(docId, { ...existing, ...(body.doc ?? {}) });
        return json({
          _index: indexName,
          _id: docId,
          _version: 2,
          result: "updated",
          _shards: { total: 1, successful: 1, failed: 0 },
          _seq_no: ++seq,
          _primary_term: 1,
        });
      }

      // /<index>/_count
      if (op === "_count") {
        const idx = indices.get(indexName);
        return json({
          count: idx ? idx.docs.size : 0,
          _shards: { total: 1, successful: 1, failed: 0 },
        });
      }

      // /<index>/_search
      if (op === "_search") {
        const idx = indices.get(indexName);
        const body = rawBody ? JSON.parse(rawBody) : {};
        let hits = idx
          ? [...idx.docs.entries()].map(([_id, _source]) => ({
              _index: indexName,
              _id,
              _score: 1.0,
              _source,
            }))
          : [];
        if (body.query?.term) {
          const [field, expected] = Object.entries(body.query.term)[0]!;
          hits = hits.filter((h) => h._source[field] === expected);
        }
        const total = hits.length;
        const size = typeof body.size === "number" ? body.size : 10;
        const from = typeof body.from === "number" ? body.from : 0;
        const page = hits.slice(from, from + size);

        const scrollParam = url.searchParams.get("scroll");
        let scrollId: string | undefined;
        if (scrollParam) {
          scrollId = `scroll-${++seq}`;
          scrolls.set(scrollId, { docs: hits, offset: page.length, size });
        }

        return json(
          {
            ...(scrollId ? { _scroll_id: scrollId } : {}),
            took: 3,
            timed_out: false,
            _shards: { total: 1, successful: 1, failed: 0 },
            hits: {
              total: { value: total, relation: "eq" },
              max_score: page.length > 0 ? 1.0 : null,
              hits: page,
            },
          },
          200,
          { warning: '299 Elasticsearch-9.0.0 "demo warning"' },
        );
      }

      // SQL / ESQL
      if (pathname === "/_sql" || pathname === "/_query") {
        const body = JSON.parse(rawBody || "{}");
        return json({ columns: [{ name: "q", type: "text" }], rows: [[body.query]] });
      }

      return json({ error: { type: "unknown_route", reason: `${method} ${pathname}` } }, 404);
    },
  });

  return {
    server,
    url: `http://127.0.0.1:${server.port}`,
    receivedRequests,
    reset() {
      indices.clear();
      pipelines.clear();
      scrolls.clear();
      receivedRequests.length = 0;
    },
  };
}

describe("@bunest/elasticsearch", () => {
  const mockEs = createMockEsServer();

  beforeAll(() => {
    mockEs.reset();
  });

  afterAll(() => {
    mockEs.server.stop(true);
  });

  describe("ElasticsearchService end-to-end against real local Bun.serve ES server", () => {
    it("supports ping, info, indices, full CRUD, search, count, mget, msearch, bulk, scroll, PIT, cluster, cat, ingest, sql, esql, and helpers", async () => {
      mockEs.reset();
      const es = new ElasticsearchService({
        node: mockEs.url,
        auth: { apiKey: { id: "key-1", api_key: "secret-1" } },
        opaqueIdPrefix: "bunest-",
      });

      expect(await es.ping()).toBe(true);
      const info = await es.info();
      expect(info.cluster_name).toBe("bunest-test-cluster");
      expect(info.version.number).toBe("9.0.0");

      // Verify ApiKey auth header & opaque-id & meta header
      const lastReq = mockEs.receivedRequests[mockEs.receivedRequests.length - 1]!;
      expect(lastReq.headers.authorization).toBe(
        `ApiKey ${Buffer.from("key-1:secret-1").toString("base64")}`,
      );
      expect(lastReq.headers["x-opaque-id"]).toMatch(/^bunest-/);
      expect(lastReq.headers["x-elastic-client-meta"]).toContain("hc=bun");

      // Indices lifecycle
      expect(await es.indices.exists({ index: "books" })).toBe(false);
      await es.indices.create({
        index: "books",
        mappings: { properties: { title: { type: "text" }, genre: { type: "keyword" } } },
      });
      expect(await es.indices.exists({ index: "books" })).toBe(true);
      await es.indices.putMapping({
        index: "books",
        properties: { pages: { type: "integer" } },
      });
      const mapping = await es.indices.getMapping({ index: "books" });
      expect(mapping.books.mappings.properties.pages.type).toBe("integer");

      await es.indices.putAlias({ index: "books", name: "books-read" });
      expect(await es.indices.existsAlias({ index: "books", name: "books-read" })).toBe(true);
      await es.indices.deleteAlias({ index: "books", name: "books-read" });
      expect(await es.indices.existsAlias({ index: "books", name: "books-read" })).toBe(false);

      // Document CRUD
      const idxRes = await es.index({
        index: "books",
        id: "b1",
        document: { title: "Bunest Deep Dive", genre: "tech", pages: 320 },
        refresh: true,
      });
      expect(idxRes.result).toBe("created");
      expect(await es.exists({ index: "books", id: "b1" })).toBe(true);
      expect(await es.exists({ index: "books", id: "missing" })).toBe(false);
      expect(await es.existsSource({ index: "books", id: "b1" })).toBe(true);

      const got = await es.get<{ title: string; genre: string; pages: number }>({
        index: "books",
        id: "b1",
      });
      expect(got.found).toBe(true);
      expect(got._source?.title).toBe("Bunest Deep Dive");

      const source = await es.getSource<{ title: string }>({ index: "books", id: "b1" });
      expect(source.title).toBe("Bunest Deep Dive");

      await es.update({
        index: "books",
        id: "b1",
        doc: { pages: 350 },
      });
      expect((await es.getSource<{ pages: number }>({ index: "books", id: "b1" })).pages).toBe(350);

      // Bulk NDJSON
      const bulkRes = await es.bulk({
        index: "books",
        operations: [
          { index: { _id: "b2" } },
          { title: "Dune", genre: "scifi", pages: 412 },
          { index: { _id: "b3" } },
          { title: "Neuromancer", genre: "scifi", pages: 271 },
        ],
      });
      expect(bulkRes.errors).toBe(false);
      expect(bulkRes.items.length).toBe(2);

      // Count, Mget, Search (with meta: true), Msearch
      expect((await es.count({ index: "books" })).count).toBe(3);

      const mgetRes = await es.mget<{ title: string }>({
        index: "books",
        ids: ["b1", "b2", "missing"],
      });
      expect(mgetRes.docs.map((d) => d.found)).toEqual([true, true, false]);

      const searchWithMeta = await es.search<{ title: string }>(
        { index: "books", query: { term: { genre: "scifi" } } },
        { meta: true },
      );
      expect(searchWithMeta.statusCode).toBe(200);
      expect(searchWithMeta.warnings.length).toBe(1);
      expect(searchWithMeta.body.hits.hits.map((h) => h._source?.title)).toEqual([
        "Dune",
        "Neuromancer",
      ]);

      const msearchRes = await es.msearch<{ title: string }>({
        index: "books",
        searches: [{}, { query: { match_all: {} } }],
      });
      expect(msearchRes.responses.length).toBe(1);
      expect(msearchRes.responses[0]!.hits.hits.length).toBe(3);

      // Scroll & helpers.scrollDocuments
      const scrolledTitles: string[] = [];
      for await (const doc of es.helpers.scrollDocuments<{ title: string }>({
        index: "books",
        size: 2,
        scroll: "1m",
      })) {
        scrolledTitles.push(doc.title);
      }
      expect(scrolledTitles).toEqual(["Bunest Deep Dive", "Dune", "Neuromancer"]);

      // helpers.bulk & helpers.search
      const bulkHelperRes = await es.helpers.bulk({
        datasource: [
          { title: "Foundation", genre: "scifi", pages: 255 },
          { title: "Hyperion", genre: "scifi", pages: 482 },
        ],
        onDocument: () => ({ index: { _index: "books" } }),
      });
      expect(bulkHelperRes.total).toBe(2);
      expect(bulkHelperRes.successful).toBe(2);

      const helperSearchDocs = await es.helpers.search<{ title: string }>({
        index: "books",
        query: { term: { genre: "tech" } },
      });
      expect(helperSearchDocs.map((d) => d.title)).toEqual(["Bunest Deep Dive"]);

      // Point in time, Cluster, Cat, Ingest, SQL, ESQL
      const pit = await es.openPointInTime({ index: "books", keep_alive: "1m" });
      expect(pit.id).toContain("pit-books");
      expect((await es.closePointInTime({ id: pit.id })).succeeded).toBe(true);

      expect((await es.cluster.health()).status).toBe("green");
      expect((await es.cat.indices()).some((i: any) => i.index === "books")).toBe(true);

      await es.ingest.putPipeline({ id: "my-pipe", description: "test", processors: [] });
      expect((await es.ingest.getPipeline({ id: "my-pipe" }))["my-pipe"].description).toBe("test");
      await es.ingest.deletePipeline({ id: "my-pipe" });

      const sqlRes = await es.sql.query({ query: "SELECT * FROM books" });
      expect(sqlRes.rows[0][0]).toBe("SELECT * FROM books");
      const esqlRes = await es.esql.query({ query: "FROM books | LIMIT 5" });
      expect(esqlRes.rows[0][0]).toBe("FROM books | LIMIT 5");

      // Delete doc & index
      const del = await es.delete({ index: "books", id: "b1" });
      expect(del.result).toBe("deleted");
      await es.indices.delete({ index: "books" });
      expect(await es.indices.exists({ index: "books" })).toBe(false);

      await es.close();
    });

    it("supports multi-node failover, retries, auth variants, compression, timeouts, child clients, and error types", async () => {
      // Failover from failing node to healthy mockEs server
      const calls: string[] = [];
      const customFetch: FetchLike = async (input, init) => {
        const url = String(input);
        calls.push(url);
        if (url.startsWith("http://dead-node.local")) {
          throw new Error("ECONNREFUSED");
        }
        return fetch(input, init);
      };

      const es = new ElasticsearchService({
        nodes: ["http://dead-node.local:9200", mockEs.url],
        auth: { username: "elastic", password: "changeme" },
        compression: true,
        maxRetries: 2,
        fetch: customFetch,
      });

      const events: string[] = [];
      es.diagnostic.on("request", () => events.push("req"));
      es.diagnostic.on("response", () => events.push("res"));

      const info = await es.info();
      expect(info.cluster_name).toBe("bunest-test-cluster");
      expect(calls[0]).toContain("http://dead-node.local:9200");
      expect(calls[1]).toContain(mockEs.url);
      expect(events).toEqual(["req", "res", "req", "res"]);

      // Gzip compression verified end-to-end against mockEs gunzip
      await es.index({
        index: "gzip_idx",
        id: "g1",
        document: { compressed: true, message: "hello bun gzip" },
      });
      const doc = await es.getSource<{ compressed: boolean; message: string }>({
        index: "gzip_idx",
        id: "g1",
      });
      expect(doc).toEqual({ compressed: true, message: "hello bun gzip" });

      // Child client shares connection pool and overrides headers / bearer auth
      const child = es.child({
        auth: { bearer: "jwt-token-xyz" },
        headers: { "x-tenant": "acme" },
      });
      expect(child.connectionPool).toBe(es.connectionPool);
      await child.info();
      const childReq = mockEs.receivedRequests[mockEs.receivedRequests.length - 1]!;
      expect(childReq.headers.authorization).toBe("Bearer jwt-token-xyz");
      expect(childReq.headers["x-tenant"]).toBe("acme");

      // 404 throws ElasticsearchResponseError
      await expect(
        es.get({ index: "gzip_idx", id: "does-not-exist" }),
      ).rejects.toThrow(ElasticsearchResponseError);

      // Timeout throws ElasticsearchTimeoutError
      const timeoutClient = new ElasticsearchService({
        node: mockEs.url,
        requestTimeout: 40,
        maxRetries: 0,
      });
      await expect(
        timeoutClient.transport.request({ method: "GET", path: "/_slow" }),
      ).rejects.toThrow(ElasticsearchTimeoutError);

      // maxPathLength validation throws ElasticsearchConnectionError
      const strictPathClient = new ElasticsearchService({
        node: mockEs.url,
        maxPathLength: 5,
      });
      await expect(
        strictPathClient.search({ index: "very-long-index-name" }),
      ).rejects.toThrow(ElasticsearchConnectionError);

      // Prototype poisoning protection
      const poisoned = es.serializer.deserialize(
        '{"ok":true,"__proto__":{"polluted":true},"nested":{"constructor":{"bad":1},"safe":42}}',
      );
      expect(poisoned.ok).toBe(true);
      expect(poisoned.nested.safe).toBe(42);
      expect(Object.prototype.hasOwnProperty.call(poisoned, "__proto__")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(poisoned.nested, "constructor")).toBe(false);

      // Cloud ID decoding
      const encoded = Buffer.from("es.us-east-1.aws.found.io$abc123$kib456").toString("base64");
      expect(parseCloudId(`my-deployment:${encoded}`)).toBe(
        "https://abc123.es.us-east-1.aws.found.io",
      );

      await es.close();
    });
  });

  describe("ElasticsearchModule DI registration", () => {
    it("supports register(), registerAsync(useFactory), registerAsync(useClass), and registerAsync(useExisting)", async () => {
      // 1. register()
      @Injectable()
      class SearchConsumer {
        constructor(
          readonly es: ElasticsearchService,
          @Inject(ELASTICSEARCH_MODULE_OPTIONS)
          readonly opts: ElasticsearchModuleOptions,
        ) {}
      }

      @Module({
        imports: [
          ElasticsearchModule.register({
            node: mockEs.url,
            name: "sync-client",
          }),
        ],
        providers: [SearchConsumer],
      })
      class SyncAppModule {}

      const syncApp = await BunestFactory.createApplicationContext(SyncAppModule);
      const consumer = syncApp.get(SearchConsumer);
      expect(consumer.es.name).toBe("sync-client");
      expect(await consumer.es.ping()).toBe(true);
      await syncApp.close();

      // 2. registerAsync(useFactory)
      const ES_URL_TOKEN = "ES_URL_TOKEN";
      @Module({
        providers: [{ provide: ES_URL_TOKEN, useValue: mockEs.url }],
        exports: [ES_URL_TOKEN],
      })
      class UrlConfigModule {}

      @Module({
        imports: [
          ElasticsearchModule.registerAsync({
            imports: [UrlConfigModule],
            inject: [ES_URL_TOKEN],
            useFactory: async (node: string) => ({
              node,
              name: "factory-client",
            }),
          }),
        ],
      })
      class FactoryAppModule {}

      const factoryApp = await BunestFactory.createApplicationContext(FactoryAppModule);
      const factoryEs = factoryApp.get(ElasticsearchService);
      expect(factoryEs.name).toBe("factory-client");
      expect((await factoryEs.info()).tagline).toBe("You Know, for Search");
      await factoryApp.close();

      // 3. registerAsync(useClass)
      @Injectable()
      class EsOptionsFactory implements ElasticsearchOptionsFactory {
        createElasticsearchOptions(): ElasticsearchModuleOptions {
          return { node: mockEs.url, name: "class-client" };
        }
      }

      @Module({
        imports: [
          ElasticsearchModule.registerAsync({
            useClass: EsOptionsFactory,
          }),
        ],
      })
      class ClassAppModule {}

      const classApp = await BunestFactory.createApplicationContext(ClassAppModule);
      expect(classApp.get(ElasticsearchService).name).toBe("class-client");
      await classApp.close();

      // 4. registerAsync(useExisting)
      @Module({
        providers: [EsOptionsFactory],
        exports: [EsOptionsFactory],
      })
      class ExistingConfigModule {}

      @Module({
        imports: [
          ElasticsearchModule.registerAsync({
            imports: [ExistingConfigModule],
            useExisting: EsOptionsFactory,
          }),
        ],
      })
      class ExistingAppModule {}

      const existingApp = await BunestFactory.createApplicationContext(ExistingAppModule);
      expect(existingApp.get(ElasticsearchService).name).toBe("class-client");
      await existingApp.close();
    });
  });
});
