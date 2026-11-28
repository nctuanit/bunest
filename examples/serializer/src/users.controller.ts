import { Controller, Get, UseInterceptors } from "@bunest/core";
import { ClassSerializerInterceptor, SerializeOptions } from "@bunest/validation";
import { RoleEntity } from "./entities/role.entity";
import { UserEntity } from "./entities/user.entity";

@Controller("users")
@UseInterceptors(ClassSerializerInterceptor)
export class UsersController {
  private buildSampleUser(): UserEntity {
    return new UserEntity({
      id: 1,
      firstName: "Ada",
      lastName: "Lovelace",
      password: "super-secret-password",
      _internalToken: "tok_private_999",
      auditNote: "Verified founding member",
      role: new RoleEntity({ id: 10, name: "admin" }),
    });
  }

  @Get("me")
  @SerializeOptions({ excludePrefixes: ["_"] })
  findOne(): UserEntity {
    return this.buildSampleUser();
  }

  @Get("admin")
  @SerializeOptions({ groups: ["admin"], excludePrefixes: ["_"] })
  findOneForAdmin(): UserEntity {
    return this.buildSampleUser();
  }

  @Get()
  @SerializeOptions({ excludePrefixes: ["_"] })
  findAll(): UserEntity[] {
    return [
      this.buildSampleUser(),
      new UserEntity({
        id: 2,
        firstName: "Grace",
        lastName: "Hopper",
        password: "another-secret-password",
        _internalToken: "tok_private_888",
        auditNote: "Compiler pioneer",
        role: new RoleEntity({ id: 11, name: "engineer" }),
      }),
    ];
  }
}
