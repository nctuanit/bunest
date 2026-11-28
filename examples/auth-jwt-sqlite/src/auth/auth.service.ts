import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@bunest/core";
import { JwtService, PasswordService } from "@bunest/security";
import { UserRepository } from "../users/user.repository";
import type { LoginDto } from "./login.dto";
import type { RegisterDto } from "./register.dto";

export interface AuthenticatedUser {
  readonly sub: string;
  readonly email: string;
  readonly roles: string[];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase();
    if (await this.users.existsByEmail(email)) {
      throw new ConflictException(`User "${dto.email}" already exists`);
    }

    const hash = await this.passwords.hash(dto.password);
    const roles = dto.roles?.length ? dto.roles : ["user"];
    const created = await this.users.save({
      email,
      passwordHash: hash,
      roles,
    });

    return {
      id: created.id,
      email: created.email,
      roles: created.roles,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.users.findByEmail(dto.email.toLowerCase());
    if (!user) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const valid = await this.passwords.verify(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const accessToken = await this.jwt.sign(
      {
        sub: String(user.id),
        email: user.email,
        roles: user.roles,
      },
      { expiresIn: "1h" },
    );

    return { accessToken };
  }
}
