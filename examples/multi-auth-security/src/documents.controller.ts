import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  type ExecutionContext,
} from "@bunest/core";
import { Can } from "@bunest/security/authz";
import { DocumentPolicy } from "./document.policy";
import { IdentityStore } from "./users.store";

function resolveDocId(context: ExecutionContext): [string] {
  const http = context.switchToHttp();
  const req = http.getRequest<{ params?: Record<string, string>; url?: string }>();
  if (req?.params?.id) {
    return [req.params.id];
  }
  const url = req?.url ?? "";
  const id = url.split("/").filter(Boolean).pop() ?? "";
  return [id];
}

@Controller("documents")
export class DocumentsController {
  constructor(private readonly store: IdentityStore) {}

  @Get(":id")
  @Can(DocumentPolicy, "read", resolveDocId)
  findOne(@Param("id") id: string) {
    const doc = this.store.findDocument(id);
    if (!doc) throw new NotFoundException(`Document ${id} not found`);
    return doc;
  }

  @Patch(":id")
  @Can(DocumentPolicy, "update", resolveDocId)
  update(@Param("id") id: string, @Body() body: { title: string }) {
    const updated = this.store.updateDocument(id, body.title);
    if (!updated) throw new NotFoundException(`Document ${id} not found`);
    return updated;
  }
}
