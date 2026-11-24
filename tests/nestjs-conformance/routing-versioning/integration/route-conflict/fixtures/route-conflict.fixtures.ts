import {
  Controller,
  Get,
  Module,
  Param,
  Version,
} from "../../../../../../packages/core/src/common";

// --- MultiUser fixture (cross-controller shadow) ---
@Controller("users")
export class UsersController {
  @Get(":userId")
  byId(@Param("userId") userId: string) {
    return { handler: "byId", userId };
  }

  @Get("me")
  me() {
    return { handler: "me" };
  }
}

@Controller({ path: "users" })
export class UserImagesController {
  @Get("images")
  images() {
    return { handler: "images" };
  }

  @Get("images/:imageId")
  imageById(@Param("imageId") imageId: string) {
    return { handler: "imageById", imageId };
  }
}

@Module({
  controllers: [UsersController, UserImagesController],
})
export class MultiUserModule {}

// --- Duplicate fixture ---
@Controller()
export class DuplicateAController {
  @Get("users/me")
  me() {
    return { from: "A" };
  }
}

@Controller()
export class DuplicateBController {
  @Get("users/me")
  me() {
    return { from: "B" };
  }
}

@Module({
  controllers: [DuplicateAController, DuplicateBController],
})
export class DuplicateModule {}

// --- Host pattern fixture ---
@Controller({ path: "users", host: ":tenant.example.com" })
export class TenantController {
  @Get()
  findAll() {
    return { from: "tenant" };
  }
}

@Controller({ path: "users", host: "admin.example.com" })
export class AdminController {
  @Get()
  findAll() {
    return { from: "admin" };
  }
}

@Module({
  controllers: [TenantController, AdminController],
})
export class HostPatternModule {}

// --- Host list fixture ---
@Controller({ host: ["a.example.com", "a.example.com"] })
export class RepeatedHostController {
  @Get("users/me")
  me() {
    return { from: "repeated" };
  }
}

@Controller({ host: ["a.example.com", "b.example.com"] })
export class TwoHostsController {
  @Get("users/me")
  me() {
    return { from: "two-hosts" };
  }
}

@Module({
  controllers: [RepeatedHostController, TwoHostsController],
})
export class HostListModule {}

// --- Same-shape fixture ---
@Controller("accounts")
export class AccountsController {
  @Get(":id")
  byId(@Param("id") id: string) {
    return { handler: "byId", id };
  }

  @Get(":username")
  byUsername(@Param("username") username: string) {
    return { handler: "byUsername", username };
  }
}

@Module({
  controllers: [AccountsController],
})
export class SameShapeModule {}

// --- Wildcard fixture (upstream Express-5 `*path` syntax & Bunest ADR-011 bare `*` syntax) ---
@Controller("files")
export class ExpressWildcardController {
  @Get("*path")
  catchAll() {
    return { handler: "catchAll" };
  }

  @Get(":fileId")
  byId(@Param("fileId") fileId: string) {
    return { handler: "byId", fileId };
  }

  @Get("readme")
  readme() {
    return { handler: "readme" };
  }
}

@Module({
  controllers: [ExpressWildcardController],
})
export class ExpressWildcardModule {}

@Controller("files")
export class WildcardController {
  @Get("*")
  catchAll() {
    return { handler: "catchAll" };
  }

  @Get(":fileId")
  byId(@Param("fileId") fileId: string) {
    return { handler: "byId", fileId };
  }

  @Get("readme")
  readme() {
    return { handler: "readme" };
  }
}

@Module({
  controllers: [WildcardController],
})
export class WildcardModule {}

// --- Versioned wildcard fixture ---
@Controller({ path: "users", version: "1" })
export class UsersMeController {
  @Get("me")
  me() {
    return { handler: "me" };
  }
}

@Controller({ path: "users" })
export class UsersWildcardController {
  @Get("profile")
  profile() {
    return { handler: "profile" };
  }

  @Version("1")
  @Get("*")
  catchAll(@Param("*") tail?: string) {
    return { handler: "catchAll", tail };
  }
}

@Module({
  controllers: [UsersMeController, UsersWildcardController],
})
export class VersionedWildcardModule {}

// --- Path-to-regexp syntax controllers ---
@Controller()
export class OptionalGroupController {
  @Get("users{/:userId}")
  find(@Param("userId") userId?: string) {
    return { handler: "find", userId };
  }

  @Get("users/:userId")
  byId(@Param("userId") userId: string) {
    return { handler: "byId", userId };
  }
}

@Controller()
export class BunestOptionalParamController {
  @Get("users/:userId?")
  find(@Param("userId") userId?: string) {
    return { handler: "find", userId };
  }

  @Get("users/:userId")
  byId(@Param("userId") userId: string) {
    return { handler: "byId", userId };
  }
}

@Controller("releases")
export class MixedSegmentController {
  @Get("v:version")
  byVersion(@Param("version") version: string) {
    return { handler: "byVersion", version };
  }

  @Get("v1")
  v1() {
    return { handler: "v1" };
  }
}

@Controller("files")
export class FileNameController {
  @Get(":name.:ext")
  byName(@Param("name") name: string, @Param("ext") ext: string) {
    return { handler: "byName", name, ext };
  }

  @Get("readme")
  readme() {
    return { handler: "readme" };
  }
}
