import { Body, Controller, Get, Post } from "@bunest/core";
import { CurrentUser, Public } from "@bunest/security";
import { AuthService, type AuthenticatedUser } from "./auth.service";
import { LoginDto } from "./login.dto";
import { RegisterDto } from "./register.dto";

@Controller("/auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post("/register")
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Post("/login")
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Get("/me")
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }
}
