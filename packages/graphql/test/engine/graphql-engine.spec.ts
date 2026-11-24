import { describe, expect, test } from "bun:test";
import {
  BREAK,
  buildASTSchema,
  buildSchema,
  defaultFieldResolver,
  DirectiveLocation,
  execute,
  formatError,
  getIntrospectionQuery,
  getOperationAST,
  getVariableValues,
  graphql,
  graphqlSync,
  GraphQLBoolean,
  GraphQLDirective,
  GraphQLEnumType,
  GraphQLError,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  GraphQLUnionType,
  isAbstractType,
  isCompositeType,
  isEnumType,
  isInputObjectType,
  isInputType,
  isInterfaceType,
  isIntrospectionType,
  isLeafType,
  isListType,
  isNonNullType,
  isObjectType,
  isOutputType,
  isScalarType,
  isSchema,
  isUnionType,
  Kind,
  lexicographicSortSchema,
  locatedError,
  NoSchemaIntrospectionCustomRule,
  parse,
  parseConstValue,
  parseType,
  parseValue,
  print,
  printSchema,
  Source,
  specifiedRules,
  subscribe,
  validate,
  visit,
} from "../../src/engine";

describe("Bunest Zero-Dep Native GraphQL October 2021 Engine", () => {
  describe("Lexer, Parser & Printer", () => {
    test("lexes BOM, comments, commas, escapes, Unicode variable-width escapes, and block string dedent", () => {
      const src = `\uFEFF
        # Leading comment
        """
          First indented line
            Nested line
          Escaped \\""" triple quote
        """
        type Note {
          text(a: String = "hello\\n\\t\\u0041\\u{1F680}", b: Float = -1.5e+2, c: Int = 0): String!
        }
      `;
      const doc = parse(src);
      expect(doc.definitions).toHaveLength(1);
      const obj = doc.definitions[0]!;
      expect(obj.kind).toBe(Kind.OBJECT_TYPE_DEFINITION);
      if (obj.kind === Kind.OBJECT_TYPE_DEFINITION) {
        expect(obj.description?.value).toBe(
          'First indented line\n  Nested line\nEscaped """ triple quote',
        );
        const args = obj.fields?.[0]?.arguments ?? [];
        expect(args[0]?.defaultValue).toMatchObject({
          kind: Kind.STRING,
          value: "hello\n\tA\u{1F680}",
        });
        expect(args[1]?.defaultValue).toMatchObject({
          kind: Kind.FLOAT,
          value: "-1.5e+2",
        });
        expect(args[2]?.defaultValue).toMatchObject({
          kind: Kind.INT,
          value: "0",
        });
      }
    });

    test("rejects malformed numbers, strings, and syntax with exact line/column locations", () => {
      expect(() => parse("query { a(x: 01) }")).toThrow(GraphQLError);
      expect(() => parse("query { a(x: 1.) }")).toThrow(GraphQLError);
      expect(() => parse("query { a(x: 123abc) }")).toThrow(GraphQLError);
      expect(() => parse('query { a(x: "unterminated\n") }')).toThrow(
        GraphQLError,
      );
      expect(() => parse("query { a(x: 'single') }")).toThrow(GraphQLError);

      try {
        parse("query {\n  valid\n  123bad\n}");
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GraphQLError);
        const gqlErr = err as GraphQLError;
        // Error points right at 'b' (column 6 on line 3) immediately following '123'
        expect(gqlErr.locations).toEqual([{ line: 3, column: 6 }]);
      }
    });

    test("respects ParseOptions (noLocation, maxTokens) and parses standalone values & types", () => {
      const noLocDoc = parse("{ a }", { noLocation: true });
      expect(noLocDoc.loc).toBeUndefined();

      expect(() => parse("{ a b c d e }", { maxTokens: 3 })).toThrow(
        /more that 3 tokens/,
      );

      expect(parseValue("{ a: [1, true, null, ENUM_VAL, $v] }")).toMatchObject({
        kind: Kind.OBJECT,
      });
      expect(() => parseConstValue("$v")).toThrow(GraphQLError);
      expect(parseType("[String!]!")).toMatchObject({
        kind: Kind.NON_NULL_TYPE,
        type: {
          kind: Kind.LIST_TYPE,
          type: {
            kind: Kind.NON_NULL_TYPE,
            type: { kind: Kind.NAMED_TYPE, name: { value: "String" } },
          },
        },
      });
    });

    test("roundtrips executable documents and full SDL (including extensions & directives) via parse -> print -> parse", () => {
      const execDoc = `query GetFeed($limit: Int = 10, $skipBio: Boolean!) @cached {
  feed(limit: $limit) {
    ... on Post {
      id
      title
      ...AuthorFields
    }
    ... @skip(if: $skipBio) {
      summary
    }
  }
}

fragment AuthorFields on Post {
  author {
    aliasName: name
  }
}`;
      const printedExec = print(parse(execDoc));
      expect(print(parse(printedExec))).toBe(printedExec);

      const sdlDoc = `
        schema { query: RootQuery }
        scalar URL @specifiedBy(url: "https://tools.ietf.org/html/rfc3986")
        directive @tag(name: String!) repeatable on OBJECT | FIELD_DEFINITION
        interface Node { id: ID! }
        interface NamedNode implements & Node { id: ID! name: String! }
        type User implements & Node & NamedNode @tag(name: "core") { id: ID! name: String! }
        extend type User { email: String }
        union Search = | User
        enum Role { ADMIN MEMBER }
        input Filter @oneOf { id: ID email: String }
        type RootQuery { user(filter: Filter!): User }
      `;
      const printedSdl = print(parse(sdlDoc));
      expect(print(parse(printedSdl))).toBe(printedSdl);
    });

    test("visit() supports enter/leave, subtree skipping, node edits, removal, and BREAK", () => {
      const doc = parse("{ a b { c d } e }");
      const seen: string[] = [];
      visit(doc, {
        Field: {
          enter(node) {
            seen.push(`enter:${node.name.value}`);
            if (node.name.value === "b") return false; // skip children c, d
            if (node.name.value === "e") return BREAK;
            return undefined;
          },
          leave(node) {
            seen.push(`leave:${node.name.value}`);
          },
        },
      });
      expect(seen).toEqual(["enter:a", "leave:a", "enter:b", "enter:e"]);

      const edited = visit(doc, {
        Field(node) {
          if (node.name.value === "d") return null; // remove
          if (node.name.value === "a") {
            return { ...node, name: { kind: Kind.NAME, value: "alpha" } };
          }
          return undefined;
        },
      });
      const printed = print(edited);
      expect(printed).toContain("alpha");
      expect(printed).not.toContain("\n    d\n");
    });
  });

  describe("Errors & Formatting", () => {
    test("GraphQLError supports options & positional constructors, formatError, and locatedError", () => {
      const src = new Source("{ fail }");
      const doc = parse(src);
      const err1 = new GraphQLError("boom", {
        nodes: doc.definitions[0],
        path: ["fail"],
        extensions: { code: "BOOM" },
      });
      expect(err1.locations).toEqual([{ line: 1, column: 1 }]);
      expect(formatError(err1)).toEqual({
        message: "boom",
        locations: [{ line: 1, column: 1 }],
        path: ["fail"],
        extensions: { code: "BOOM" },
      });

      const cause = new Error("root cause");
      const located = locatedError(cause, doc.definitions[0], ["items", 2]);
      expect(located.originalError).toBe(cause);
      expect(located.path).toEqual(["items", 2]);
      expect(located.locations).toEqual([{ line: 1, column: 1 }]);
    });
  });

  describe("Scalars, Types, Type Guards, SDL & Introspection", () => {
    test("built-in scalars enforce GraphQL October 2021 coercion rules", () => {
      expect(GraphQLInt.parseValue(42)).toBe(42);
      expect(GraphQLInt.serialize(true)).toBe(1);
      expect(() => GraphQLInt.parseValue(3.14)).toThrow(GraphQLError);
      expect(() => GraphQLInt.parseValue(2147483648)).toThrow(GraphQLError);
      expect(() => GraphQLInt.parseValue("42")).toThrow(GraphQLError);

      expect(GraphQLFloat.parseValue(3.14)).toBe(3.14);
      expect(GraphQLFloat.parseLiteral({ kind: Kind.INT, value: "7" })).toBe(7);
      expect(() => GraphQLFloat.parseValue(Number.NaN)).toThrow(GraphQLError);
      expect(() => GraphQLFloat.parseValue(Number.POSITIVE_INFINITY)).toThrow(
        GraphQLError,
      );

      expect(GraphQLString.parseValue("hi")).toBe("hi");
      expect(GraphQLString.serialize(123)).toBe("123");
      expect(() => GraphQLString.parseValue(123)).toThrow(GraphQLError);

      expect(GraphQLBoolean.parseValue(false)).toBe(false);
      expect(GraphQLBoolean.serialize(0)).toBe(false);
      expect(() => GraphQLBoolean.parseValue("true")).toThrow(GraphQLError);

      expect(GraphQLID.parseValue(99)).toBe("99");
      expect(GraphQLID.parseValue("abc")).toBe("abc");
      expect(GraphQLID.parseLiteral({ kind: Kind.INT, value: "42" })).toBe("42");
      expect(() => GraphQLID.parseValue(1.5)).toThrow(GraphQLError);
    });

    test("GraphQLEnumType handles custom internal values and rejects invalid values", () => {
      const Priority = new GraphQLEnumType({
        name: "Priority",
        values: {
          LOW: { value: 0 },
          HIGH: { value: 10, deprecationReason: "Use URGENT" },
        },
      });
      expect(Priority.serialize(0)).toBe("LOW");
      expect(Priority.parseValue("LOW")).toBe(0);
      expect(Priority.parseLiteral({ kind: Kind.ENUM, value: "HIGH" })).toBe(10);
      expect(() => Priority.parseValue("UNKNOWN")).toThrow(GraphQLError);
      expect(() => Priority.serialize(999)).toThrow(GraphQLError);
    });

    test("buildASTSchema merges type extensions, printSchema roundtrips, and lexicographicSortSchema sorts cleanly", () => {
      const sdl = `
        """Custom email scalar"""
        scalar Email @specifiedBy(url: "https://example.com/email")

        directive @auth(role: Role = USER) repeatable on FIELD_DEFINITION | OBJECT

        enum Role {
          ZEBRA
          ADMIN @deprecated(reason: "Use SUPERADMIN")
          USER
        }

        interface Node {
          id: ID!
        }

        interface Timestamped implements Node {
          id: ID!
          createdAt: String!
        }

        type User implements Node & Timestamped {
          zField: String
          id: ID!
          createdAt: String!
          email: Email
        }

        extend type User {
          aField(z: Int = 2, a: String = "x"): Boolean!
        }

        input Lookup @oneOf {
          zKey: String
          aKey: ID
        }

        union Result = User

        type Query {
          zeta: Result
          alpha(lookup: Lookup): User
        }
      `;
      const schema = buildASTSchema(parse(sdl));
      expect(isSchema(schema)).toBe(true);
      expect(isScalarType(schema.getType("Email"))).toBe(true);
      expect(isObjectType(schema.getType("User"))).toBe(true);
      expect(isInterfaceType(schema.getType("Node"))).toBe(true);
      expect(isUnionType(schema.getType("Result"))).toBe(true);
      expect(isEnumType(schema.getType("Role"))).toBe(true);
      expect(isInputObjectType(schema.getType("Lookup"))).toBe(true);
      expect(isIntrospectionType(schema.getType("__Schema"))).toBe(true);
      expect(isOutputType(schema.getType("User"))).toBe(true);
      expect(isInputType(schema.getType("Lookup"))).toBe(true);
      expect(isAbstractType(schema.getType("Node"))).toBe(true);
      expect(isCompositeType(schema.getType("Result"))).toBe(true);
      expect(isLeafType(schema.getType("Role"))).toBe(true);

      const userType = schema.getType("User") as GraphQLObjectType;
      expect(userType.getFields().aField).toBeDefined();
      expect(
        schema.getPossibleTypes(schema.getType("Node") as GraphQLInterfaceType).map((t) => t.name),
      ).toEqual(["User"]);
      expect(
        schema.getImplementations(schema.getType("Node") as GraphQLInterfaceType).interfaces.map((t) => t.name),
      ).toEqual(["Timestamped"]);

      const sorted = lexicographicSortSchema(schema);
      const printed = printSchema(sorted);
      expect(printed).toContain('@specifiedBy(url: "https://example.com/email")');
      expect(printed).toContain("input Lookup @oneOf");
      expect(printed).toContain('@deprecated(reason: "Use SUPERADMIN")');
      expect(printed.indexOf("aField(")).toBeLessThan(printed.indexOf("zField:"));
      expect(printed.indexOf("a: String")).toBeLessThan(printed.indexOf("z: Int"));
      expect(printed.indexOf("alpha(")).toBeLessThan(printed.indexOf("zeta:"));

      // Roundtrip printSchema -> buildSchema
      const rebuilt = buildSchema(printed);
      expect(printSchema(rebuilt)).toBe(printed);
    });

    test("executes full GraphQL Introspection (__schema, __type, __typename)", async () => {
      const schema = buildSchema(`
        """Root schema description"""
        schema { query: Query }
        scalar Date @specifiedBy(url: "https://iso.org/date")
        enum Status { ACTIVE OLD @deprecated(reason: "Retired") }
        input OneOfFilter @oneOf { id: ID code: String }
        interface Entity { id: ID! }
        type Item implements Entity {
          id: ID!
          name(prefix: String = "pre"): String!
          oldField: String @deprecated
        }
        type Query {
          item(filter: OneOfFilter): Item
          status: Status
          today: Date
        }
      `);

      const res = await execute({
        schema,
        document: parse(`
          query Introspect {
            __typename
            __schema {
              description
              queryType { name }
              mutationType { name }
              directives { name isRepeatable locations }
            }
            itemType: __type(name: "Item") {
              kind
              name
              interfaces { name }
              fields(includeDeprecated: false) {
                name
                args { name defaultValue type { kind name } }
              }
              allFields: fields(includeDeprecated: true) {
                name
                isDeprecated
                deprecationReason
              }
            }
            entityType: __type(name: "Entity") {
              kind
              possibleTypes { name }
            }
            statusType: __type(name: "Status") {
              enumValues(includeDeprecated: false) { name }
              allEnumValues: enumValues(includeDeprecated: true) { name isDeprecated deprecationReason }
            }
            dateType: __type(name: "Date") { specifiedByURL }
            oneOfType: __type(name: "OneOfFilter") { isOneOf inputFields { name } }
          }
        `),
      });

      expect(res.errors).toBeUndefined();
      const data = res.data as any;
      expect(data.__typename).toBe("Query");
      expect(data.__schema.description).toBe("Root schema description");
      expect(data.__schema.queryType.name).toBe("Query");
      expect(data.__schema.mutationType).toBeNull();
      expect(data.itemType.interfaces).toEqual([{ name: "Entity" }]);
      expect(data.itemType.fields.map((f: any) => f.name)).toEqual(["id", "name"]);
      expect(data.itemType.fields[1].args[0].defaultValue).toBe('"pre"');
      expect(data.itemType.allFields.map((f: any) => f.name)).toEqual([
        "id",
        "name",
        "oldField",
      ]);
      expect(data.entityType.possibleTypes).toEqual([{ name: "Item" }]);
      expect(data.statusType.enumValues).toEqual([{ name: "ACTIVE" }]);
      expect(data.statusType.allEnumValues).toEqual([
        { name: "ACTIVE", isDeprecated: false, deprecationReason: null },
        { name: "OLD", isDeprecated: true, deprecationReason: "Retired" },
      ]);
      expect(data.dateType.specifiedByURL).toBe("https://iso.org/date");
      expect(data.oneOfType.isOneOf).toBe(true);
    });
  });

  describe("Validation Rules (October 2021 Spec + Security)", () => {
    const schema = buildSchema(`
      directive @custom(flag: Boolean!) on FIELD
      directive @rep repeatable on FIELD
      enum Color { RED BLUE }
      input FilterInput {
        requiredTag: String!
        tags: [String!]
        color: Color
      }
      input ChoiceInput @oneOf {
        byId: ID
        bySlug: String
      }
      interface Pet { name: String! }
      type Dog implements Pet { name: String! bark: Boolean! }
      type Cat implements Pet { name: String! meow: Boolean! }
      type Query {
        pet: Pet
        dog: Dog
        greet(name: String!, count: Int = 1): String!
        search(filter: FilterInput, choice: ChoiceInput): [String!]!
      }
      type Subscription {
        ticks: Int!
        other: String!
      }
    `);

    const checkInvalid = (query: string, expectedSubstr: string) => {
      const errs = validate(schema, parse(query), specifiedRules);
      expect(errs.length).toBeGreaterThan(0);
      expect(errs.map((e) => e.message).join(" | ")).toContain(expectedSubstr);
    };

    const checkValid = (query: string) => {
      const errs = validate(schema, parse(query), specifiedRules);
      expect(errs).toEqual([]);
    };

    test("validates all major October 2021 spec rules", () => {
      // Valid complex query
      checkValid(`
        query Q($n: String!, $flag: Boolean!) {
          greet(name: $n) @custom(flag: $flag) @rep @rep
          search(filter: { requiredTag: "x", tags: "single-coerced", color: RED }, choice: { byId: "1" })
          pet {
            name
            ...DogFrag
            ... on Cat { meow }
          }
        }
        fragment DogFrag on Dog { bark }
      `);

      // ExecutableDefinitionsRule
      checkInvalid("type Extra { id: ID }", "not executable");
      // UniqueOperationNamesRule & LoneAnonymousOperationRule
      checkInvalid("query A { greet(name: \"a\") } query A { greet(name: \"b\") }", 'only one operation named "A"');
      checkInvalid("{ greet(name: \"a\") } query B { greet(name: \"b\") }", "must be the only defined operation");
      // SingleFieldSubscriptionsRule
      checkInvalid("subscription { ticks other }", "must select only one top level field");
      checkInvalid("subscription { __typename }", "must not select an introspection top level field");
      // KnownTypeNamesRule & FragmentsOnCompositeTypesRule & VariablesAreInputTypesRule
      checkInvalid("query ($x: MissingType) { greet(name: \"a\") }", 'Unknown type "MissingType"');
      checkInvalid("query { pet { ... on String { __typename } } }", "non composite type");
      checkInvalid("query ($d: Dog) { greet(name: \"a\") }", "cannot be non-input type");
      // ScalarLeafsRule & FieldsOnCorrectTypeRule
      checkInvalid('{ greet(name: "a") { sub } }', "must not have a selection");
      checkInvalid("{ dog }", "must have a selection of subfields");
      checkInvalid('{ dog { nonexistent } }', 'Cannot query field "nonexistent"');
      // Fragments: unique, known, unused, possible spread, cycles
      checkInvalid("{ dog { ...F } } fragment F on Dog { name } fragment F on Dog { bark }", 'only one fragment named "F"');
      checkInvalid("{ dog { ...Missing } }", 'Unknown fragment "Missing"');
      checkInvalid('{ greet(name: "a") } fragment Unused on Dog { name }', 'Fragment "Unused" is never used');
      checkInvalid("{ dog { ... on Cat { meow } } }", 'can never be of type "Cat"');
      checkInvalid("{ dog { ...A } } fragment A on Dog { ...B } fragment B on Dog { ...A }", 'Cannot spread fragment "A" within itself');
      // Variables: unique, undefined, unused, allowed position
      checkInvalid("query ($a: String!, $a: String!) { greet(name: $a) }", 'only one variable named "$a"');
      checkInvalid("query { greet(name: $missing) }", 'Variable "$missing" is not defined');
      checkInvalid('query ($unused: Int) { greet(name: "a") }', 'Variable "$unused" is never used');
      checkInvalid("query ($maybeName: String) { greet(name: $maybeName) }", 'used in position expecting type "String!"');
      // Directives: known, location, unique vs repeatable
      checkInvalid('{ greet(name: "a") @unknown }', 'Unknown directive "@unknown"');
      checkInvalid('query @custom(flag: true) { greet(name: "a") }', 'may not be used on QUERY');
      checkInvalid('{ greet(name: "a") @custom(flag: true) @custom(flag: false) }', 'can only be used once');
      // Arguments: known, unique, required
      checkInvalid('{ greet(name: "a", extra: 1) }', 'Unknown argument "extra"');
      checkInvalid('{ greet(name: "a", name: "b") }', 'only one argument named "name"');
      checkInvalid("{ greet }", 'argument "name" of type "String!" is required');
      // ValuesOfCorrectType & UniqueInputFieldNames & @oneOf
      checkInvalid('{ greet(name: 123) }', "cannot represent a non string value");
      checkInvalid("{ search(filter: {}) }", 'Field "FilterInput.requiredTag" of required type "String!" was not provided');
      checkInvalid('{ search(filter: { requiredTag: "a", unknownField: 1 }) }', 'Field "unknownField" is not defined');
      checkInvalid('{ search(filter: { requiredTag: "a", requiredTag: "b" }) }', 'only one input field named "requiredTag"');
      checkInvalid('{ search(choice: { byId: "1", bySlug: "s" }) }', "must specify exactly one key");
      checkInvalid("{ search(choice: { byId: null }) }", "must be non-null");
      // OverlappingFieldsCanBeMergedRule
      checkInvalid("{ dog { x: name x: bark } }", 'Fields "x" conflict');
      checkInvalid('{ a: greet(name: "1") a: greet(name: "2") }', "differing arguments");
      checkValid("{ pet { ... on Dog { x: bark } ... on Cat { x: meow } } }"); // mutually exclusive boolean fields
    });

    test("NoSchemaIntrospectionCustomRule blocks __schema and __type while allowing __typename", () => {
      const rules = [...specifiedRules, NoSchemaIntrospectionCustomRule];
      expect(validate(schema, parse("{ __typename }"), rules)).toEqual([]);
      expect(
        validate(schema, parse("{ __schema { types { name } } }"), rules).length,
      ).toBeGreaterThan(0);
      expect(
        validate(schema, parse('{ __type(name: "Dog") { name } }'), rules).length,
      ).toBeGreaterThan(0);
    });

    test("respects maxErrors option in validate()", () => {
      const errs = validate(
        schema,
        parse("{ a b c d e f }"),
        specifiedRules,
        { maxErrors: 2 },
      );
      expect(errs.length).toBe(3); // 2 errors + abort notice
      expect(errs[2]!.message).toContain("Validation aborted");
    });
  });

  describe("Execution, Variable Coercion, Non-Null Bubbling & Subscriptions", () => {
    test("executes queries in parallel, mutations serially, supports directives, fragments, abstract types, and non-null error bubbling", async () => {
      const mutationOrder: string[] = [];

      const ItemInterface = new GraphQLInterfaceType({
        name: "Item",
        fields: {
          id: { type: new GraphQLNonNull(GraphQLID) },
        },
        resolveType: (val: { kind?: string }) =>
          val.kind === "book" ? "Book" : "Movie",
      });

      const BookType = new GraphQLObjectType({
        name: "Book",
        interfaces: [ItemInterface],
        fields: {
          id: { type: new GraphQLNonNull(GraphQLID) },
          title: { type: new GraphQLNonNull(GraphQLString) },
        },
      });

      const MovieType = new GraphQLObjectType({
        name: "Movie",
        interfaces: [ItemInterface],
        fields: {
          id: { type: new GraphQLNonNull(GraphQLID) },
          director: { type: new GraphQLNonNull(GraphQLString) },
        },
      });

      const NullableParent = new GraphQLObjectType({
        name: "NullableParent",
        fields: {
          requiredChild: {
            type: new GraphQLNonNull(GraphQLString),
            resolve: () => null, // triggers non-null bubbling!
          },
        },
      });

      const QueryType = new GraphQLObjectType({
        name: "Query",
        fields: {
          items: {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ItemInterface))),
            resolve: () => [
              { kind: "book", id: "b1", title: "SICP" },
              { kind: "movie", id: "m1", director: "Kubrick" },
            ],
          },
          nullableParent: {
            type: NullableParent,
            resolve: () => ({}),
          },
          nullableList: {
            type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
            resolve: () => ["ok", null], // item 1 fails non-null -> nulls entire list
          },
          echo: {
            type: new GraphQLList(GraphQLString),
            args: {
              tags: { type: new GraphQLList(GraphQLString), defaultValue: ["def"] },
            },
            resolve: (_p, args) => args.tags,
          },
        },
      });

      const MutationType = new GraphQLObjectType({
        name: "Mutation",
        fields: {
          step: {
            type: GraphQLString,
            args: { label: { type: new GraphQLNonNull(GraphQLString) } },
            resolve: async (_p, args: { label: string }) => {
              await Bun.sleep(args.label === "first" ? 20 : 1);
              mutationOrder.push(args.label);
              return args.label;
            },
          },
        },
      });

      const schema = new GraphQLSchema({
        query: QueryType,
        mutation: MutationType,
        types: [BookType, MovieType],
      });

      // 1. Directives (@skip, @include), fragments, abstract resolution, default args, single-item list coercion
      const qDoc = parse(`
        query Main($hideDir: Boolean!, $incTitle: Boolean!, $single: [String]) {
          items {
            __typename
            id
            ... on Book { title @include(if: $incTitle) }
            ... on Movie { director @skip(if: $hideDir) }
          }
          echoDefault: echo
          echoCoerced: echo(tags: $single)
        }
        query Secondary { echo }
      `);
      expect(getOperationAST(qDoc, "Main")?.name?.value).toBe("Main");
      expect(getOperationAST(qDoc)).toBeNull(); // ambiguous without operationName

      const qRes = await execute({
        schema,
        document: qDoc,
        operationName: "Main",
        variableValues: { hideDir: true, incTitle: true, single: "solo" },
      });
      expect(qRes.errors).toBeUndefined();
      expect(qRes.data).toEqual({
        items: [
          { __typename: "Book", id: "b1", title: "SICP" },
          { __typename: "Movie", id: "m1" },
        ],
        echoDefault: ["def"],
        echoCoerced: ["solo"],
      });

      // 2. Non-null error bubbling (field -> nullableParent: null, list item -> nullableList: null)
      const bubbleRes = await execute({
        schema,
        document: parse("{ nullableParent { requiredChild } nullableList }"),
      });
      expect(bubbleRes.data).toEqual({
        nullableParent: null,
        nullableList: null,
      });
      expect(bubbleRes.errors?.length).toBe(2);
      expect(bubbleRes.errors?.[0]?.path).toEqual([
        "nullableParent",
        "requiredChild",
      ]);
      expect(bubbleRes.errors?.[1]?.path).toEqual(["nullableList", 1]);

      // 3. Mutations execute serially (first completes before second starts!)
      const mutRes = await execute({
        schema,
        document: parse(
          'mutation { a: step(label: "first") b: step(label: "second") }',
        ),
      });
      expect(mutRes.data).toEqual({ a: "first", b: "second" });
      expect(mutationOrder).toEqual(["first", "second"]);
    });

    test("getVariableValues validates required variables, defaults, and @oneOf inputs", () => {
      const schema = buildSchema(`
        input Choice @oneOf { a: Int b: String }
        type Query { ok: Boolean }
      `);
      const doc = parse(
        "query ($req: Int!, $def: String = \"hi\", $ch: Choice) { ok }",
      );
      const op = getOperationAST(doc)!;

      const missing = getVariableValues(schema, op.variableDefinitions!, {});
      expect(missing.errors?.length).toBe(1);

      const ok = getVariableValues(schema, op.variableDefinitions!, {
        req: 5,
        ch: { a: 1 },
      });
      expect(ok.errors).toBeUndefined();
      expect(ok.coerced).toEqual({ req: 5, def: "hi", ch: { a: 1 } });

      const badOneOf = getVariableValues(schema, op.variableDefinitions!, {
        req: 5,
        ch: { a: 1, b: "both" },
      });
      expect(badOneOf.errors?.[0]?.message).toContain("OneOf");
    });

    test("subscribe() streams events via AsyncIterable and cleanly calls return() on teardown", async () => {
      let cleanedUp = false;
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: { ok: { type: GraphQLBoolean, resolve: () => true } },
        }),
        subscription: new GraphQLObjectType({
          name: "Subscription",
          fields: {
            counter: {
              type: new GraphQLNonNull(GraphQLInt),
              args: { start: { type: GraphQLInt, defaultValue: 1 } },
              async *subscribe(_root, args: { start: number }) {
                try {
                  yield { counter: args.start };
                  yield { counter: args.start + 1 };
                  yield { counter: args.start + 2 };
                } finally {
                  cleanedUp = true;
                }
              },
              resolve: (payload: { counter: number }) => payload.counter * 10,
            },
          },
        }),
      });

      const sub = await subscribe({
        schema,
        document: parse("subscription { counter(start: 2) }"),
      });
      expect(Symbol.asyncIterator in sub).toBe(true);
      const iter = sub as AsyncIterableIterator<any>;

      expect((await iter.next()).value).toEqual({ data: { counter: 20 } });
      expect((await iter.next()).value).toEqual({ data: { counter: 30 } });
      await iter.return?.();
      expect(cleanedUp).toBe(true);
      expect((await iter.next()).done).toBe(true);
    });

    test("duck-typing compatibility works with externally constructed schema & object types", async () => {
      const extQueryType: any = {
        [Symbol.toStringTag]: "GraphQLObjectType",
        name: "Query",
        getInterfaces: () => [],
        getFields: () => ({
          hello: {
            name: "hello",
            type: GraphQLString,
            args: [],
            resolve: () => "from-external-schema",
          },
        }),
      };

      const extSchema: any = {
        [Symbol.toStringTag]: "GraphQLSchema",
        getQueryType: () => extQueryType,
        getMutationType: () => undefined,
        getSubscriptionType: () => undefined,
        getTypeMap: () => ({ Query: extQueryType, String: GraphQLString }),
        getType: (name: string) =>
          name === "Query"
            ? extQueryType
            : name === "String"
              ? GraphQLString
              : undefined,
        getDirectives: () => [],
        getDirective: () => undefined,
        getPossibleTypes: () => [],
        isSubType: () => false,
      };

      expect(isSchema(extSchema)).toBe(true);
      expect(isObjectType(extQueryType)).toBe(true);
      expect(isListType(new GraphQLList(GraphQLString))).toBe(true);
      expect(isNonNullType(new GraphQLNonNull(GraphQLString))).toBe(true);

      const doc = parse("{ hello }");
      expect(validate(extSchema, doc)).toEqual([]);
      const res = await execute({ schema: extSchema, document: doc });
      expect(res).toEqual({ data: { hello: "from-external-schema" } });

      // defaultFieldResolver works on functions and plain objects
      expect(
        defaultFieldResolver(
          { prop: () => "fn-val" },
          {},
          {},
          { fieldName: "prop" } as any,
        ),
      ).toBe("fn-val");
    });

    test("async resolvers returning Error instances preserve exact field locations & path, and graphql()/graphqlSync()/getIntrospectionQuery() work end-to-end", async () => {
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            ok: { type: GraphQLString, resolve: () => "sync-ok" },
            asyncReturnedErr: {
              type: new GraphQLNonNull(GraphQLString),
              resolve: async () => new Error("Returned error value"),
            },
            listWithReturnedErr: {
              type: new GraphQLList(GraphQLString),
              resolve: () => [
                Promise.resolve("good"),
                Promise.resolve(new Error("Item returned error")),
              ],
            },
          },
        }),
      });

      // Async resolver resolving to an Error instance must locate on the field (line 2, col 3) with path ["asyncReturnedErr"]
      const errRes = await graphql({
        schema,
        source: "{\n  asyncReturnedErr\n}\n",
      });
      expect(errRes.data).toBeNull();
      expect(errRes.errors).toHaveLength(1);
      expect(errRes.errors?.[0]?.toJSON()).toEqual({
        message: "Returned error value",
        locations: [{ line: 2, column: 3 }],
        path: ["asyncReturnedErr"],
      });

      // Async list item resolving to an Error instance preserves item path ["listWithReturnedErr", 1]
      const listRes = await graphql({
        schema,
        source: "{\n  listWithReturnedErr\n}\n",
      });
      expect(listRes.data).toEqual({ listWithReturnedErr: ["good", null] });
      expect(listRes.errors?.[0]?.toJSON()).toEqual({
        message: "Item returned error",
        locations: [{ line: 2, column: 3 }],
        path: ["listWithReturnedErr", 1],
      });

      // graphqlSync works for sync resolvers and rejects async resolvers
      expect(graphqlSync({ schema, source: "{ ok }" })).toEqual({
        data: { ok: "sync-ok" },
      });
      expect(() =>
        graphqlSync({ schema, source: "{ asyncReturnedErr }" }),
      ).toThrow(/synchronously/);

      // getIntrospectionQuery runs cleanly against schema
      const introRes = await graphql({
        schema,
        source: getIntrospectionQuery({
          specifiedByUrl: true,
          directiveIsRepeatable: true,
          schemaDescription: true,
          inputValueDeprecation: true,
          oneOf: true,
        }),
      });
      expect(introRes.errors).toBeUndefined();
      expect((introRes.data as any).__schema.queryType.name).toBe("Query");
    });
  });
});
