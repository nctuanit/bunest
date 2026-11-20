import {
  type ASTVisitor,
  type FragmentDefinitionNode,
  GraphQLError,
  Kind,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
} from "graphql";

/**
 * Creates a GraphQL validation rule that rejects operations whose selection-set
 * nesting depth exceeds `maxDepth`, protecting against deeply nested DoS queries.
 * Uses relative-depth memoization across named fragments so shared diamond DAG
 * fragments evaluate in O(V + E) linear time instead of exponential O(2^n).
 */
export function createDepthLimitRule(maxDepth: number): ValidationRule {
  return (context: ValidationContext): ASTVisitor => {
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const def of context.getDocument().definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) {
        fragments.set(def.name.value, def);
      }
    }

    const fragmentDepthMemo = new Map<string, number>();

    const measureRelativeDepth = (
      selectionSet: SelectionSetNode | undefined,
      activeFragments: Set<string>,
    ): { depth: number; hitCycle: boolean } => {
      if (!selectionSet) {
        return { depth: 0, hitCycle: false };
      }

      let maxSeen = 0;
      let hitCycle = false;

      for (const selection of selectionSet.selections) {
        if (selection.kind === Kind.FIELD) {
          // Ignore introspection meta-fields (`__typename`) from inflating depth
          if (selection.name.value === "__typename") {
            continue;
          }
          let fieldDepth = 1;
          if (selection.selectionSet) {
            const child = measureRelativeDepth(
              selection.selectionSet,
              activeFragments,
            );
            fieldDepth = 1 + child.depth;
            if (child.hitCycle) hitCycle = true;
          }
          if (fieldDepth > maxSeen) {
            maxSeen = fieldDepth;
          }
        } else if (selection.kind === Kind.INLINE_FRAGMENT) {
          const inline = measureRelativeDepth(
            selection.selectionSet,
            activeFragments,
          );
          if (inline.depth > maxSeen) {
            maxSeen = inline.depth;
          }
          if (inline.hitCycle) hitCycle = true;
        } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
          const fragName = selection.name.value;
          const cached = fragmentDepthMemo.get(fragName);
          if (cached !== undefined) {
            if (cached > maxSeen) {
              maxSeen = cached;
            }
            continue;
          }

          if (activeFragments.has(fragName)) {
            hitCycle = true;
            continue;
          }

          const frag = fragments.get(fragName);
          if (!frag) {
            continue;
          }

          activeFragments.add(fragName);
          const fragResult = measureRelativeDepth(
            frag.selectionSet,
            activeFragments,
          );
          activeFragments.delete(fragName);

          if (!fragResult.hitCycle) {
            fragmentDepthMemo.set(fragName, fragResult.depth);
          } else {
            hitCycle = true;
          }

          if (fragResult.depth > maxSeen) {
            maxSeen = fragResult.depth;
          }
        }
      }

      return { depth: maxSeen, hitCycle };
    };

    return {
      OperationDefinition(node) {
        const { depth } = measureRelativeDepth(node.selectionSet, new Set());
        if (depth > maxDepth) {
          const opName = node.name?.value
            ? ` "${node.name.value}"`
            : "";
          context.reportError(
            new GraphQLError(
              `GraphQL query${opName} exceeds maximum allowed depth of ${maxDepth} (measured: ${depth}).`,
              {
                nodes: node,
                extensions: {
                  code: "QUERY_DEPTH_LIMIT_EXCEEDED",
                  maxDepth,
                  depth,
                },
              },
            ),
          );
        }
      },
    };
  };
}
