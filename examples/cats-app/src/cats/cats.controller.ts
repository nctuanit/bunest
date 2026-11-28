import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from "@bunest/core";
import { Roles } from "../common/decorators/roles.decorator";
import { Actor } from "../common/decorators/user.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { LoggingInterceptor } from "../common/interceptors/logging.interceptor";
import { TransformInterceptor } from "../common/interceptors/transform.interceptor";
import { CatsService } from "./cats.service";
import { CreateCatDto } from "./dto/create-cat.dto";
import type { Cat } from "./interfaces/cat.interface";

@Controller("cats")
@UseGuards(RolesGuard)
@UseInterceptors(LoggingInterceptor, TransformInterceptor)
export class CatsController {
  constructor(private readonly catsService: CatsService) {}

  @Post()
  @Roles("admin")
  create(@Body() createCatDto: CreateCatDto, @Actor() actor: string): Cat {
    return this.catsService.create(createCatDto, actor);
  }

  @Get()
  findAll(): Cat[] {
    return this.catsService.findAll();
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number): Cat {
    return this.catsService.findOne(id);
  }
}
