# Chỉ mục ADR & RFC

Kiến trúc lõi của Bunest được chi phối bởi các **Bản ghi Quyết định Kiến trúc (ADR)** và **RFC** chính thức lưu trong `docs/adr/` và `docs/rfcs/` của kho mã nguồn. Toàn bộ 19 package trong monorepo đều tuân thủ và được kiểm thử theo các bất biến chuẩn mực này.

## Các RFC

| ID | Tiêu đề | Trạng thái | Tài liệu hướng dẫn |
| --- | --- | --- | --- |
| **RFC-001** | Định tuyến Controller kiểu NestJS & Thực thi Biên dịch lúc Khởi động | Accepted | [Controllers](/overview/controllers) |

## Nền tảng Runtime, TypeScript & Decorator

| ADR | Tóm tắt quyết định | Trạng thái | Ngày |
| --- | --- | --- | --- |
| **ADR-001** | Runtime chỉ dành cho Bun (`>= 1.4.5`, không dùng Express/Fastify/Node HTTP trong core) | Accepted | 2026-11-20 |
| **ADR-002** | Legacy TypeScript Decorators (`experimentalDecorators`, `emitDecoratorMetadata`, `verbatimModuleSyntax: true` + value-import cho các class) | Accepted | 2026-11-20 |

## Định tuyến & Gắn kết Tham số

| ADR | Tóm tắt quyết định | Trạng thái | Hướng dẫn |
| --- | --- | --- | --- |
| **ADR-003** | Controller kiểu NestJS + Method Decorators (mặc định singleton phi trạng thái) | Accepted | [Controllers](/overview/controllers) |
| **ADR-004** | Legacy Parameter Decorators thay thế `static parameters` (khóa theo chỉ số, phân tích body có cache) | Accepted | [Controllers](/overview/controllers) |
| **ADR-006** | Class Decorator `@Controller()`, HTTP Method Decorators & Hợp đồng Controller Scanner | Accepted | [Controllers](/overview/controllers) |
| **ADR-010** | Hợp đồng Tuần tự hóa Phản hồi, Mã trạng thái mặc định (`POST -> 201`) & Response Decorators | Accepted | [Response Serialization](/architecture/response-serialization) |
| **ADR-011** | Ma trận hỗ trợ Native Routes của `Bun.serve({ routes })` (Bun 1.4.5) & Fallback Dispatcher có kiểm soát | Accepted | [Hybrid Router](/architecture/hybrid-router) |

## Dependency Injection & Module

| ADR | Tóm tắt quyết định | Trạng thái | Hướng dẫn |
| --- | --- | --- | --- |
| **ADR-007** | Provider theo phạm vi Module, Khả năng hiển thị Export, Re-Export, Dynamic & Global Modules | Accepted | [Modules](/overview/modules) |
| **ADR-012** | Lan truyền DI theo phạm vi Request (`AsyncLocalStorage` / `RequestContainer`) & Phát hiện rò rỉ phạm vi Fail-Fast | Accepted | [Injection Scopes](/fundamentals/injection-scopes) |

## Xác thực dữ liệu, HTTP Pipeline, Tương đồng & Service-Layer AOP

| ADR | Tóm tắt quyết định | Trạng thái | Hướng dẫn |
| --- | --- | --- | --- |
| **ADR-005** | `class-validator` + `class-transformer` làm công cụ kiểm tra DTO mặc định (`PipeTransform` seam) | Superseded by ADR-015 | [Validation](/techniques/validation) |
| **ADR-008** | Thứ tự chính xác của Pipeline Thực thi HTTP 11 Giai đoạn & Quy tắc ưu tiên | Accepted | [Execution Pipeline](/architecture/execution-pipeline) |
| **ADR-009** | Tùy chọn mặc định của `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `forbidUnknownValues`) & Định dạng JSON HTTP 400 chuẩn hóa | Accepted | [Validation](/techniques/validation) |
| **ADR-013** | Hợp đồng tương đồng API NestJS v12.5.1, Bảo mật HTTP tích hợp & Kiểm tra đồ thị | Accepted | [Migration from NestJS](/architecture/migration-from-nestjs) |
| **ADR-014** | Dệt Aspect phương thức tầng Service, Decorator khai báo (`@Transactional`, `@Cacheable`, `@Span`, `@EmitEvent`, `@WithLock`, `@Retry`, `@UseMiddleware`) & Repository biên dịch một lần | Accepted | [Service-Layer AOP](/techniques/service-aop) |
| **ADR-015** | Bộ máy Kiểm tra & Biến đổi DTO gốc trên Bun (Không phụ thuộc ngoài, Kế hoạch biên dịch một lần) | Accepted | [Validation](/techniques/validation) |
| **ADR-016** | Hợp nhất 37 → 19 Package (6 Lĩnh vực, ESM Subpath Exports) & Đồng bộ API gốc Bun 1.4.5 | Accepted | [Packages & Monorepo](/ecosystem/packages) |
| **ADR-017** | Không phụ thuộc runtime bên ngoài (19/19 Package) & Cách ly 2 Adapter `node:*` toàn repo | Accepted (Completed) | [Packages & Monorepo](/ecosystem/packages) |
| **ADR-018** | Kiến trúc Magic tùy biến: `Bun.plugin` hợp nhất, Macro mở rộng, Repository Scopes/Operators, AOP Phases/Pointcuts, Typegen & Diagnostic Plugins, `@AutoModule` có điều kiện | Accepted | [CLI & `bunest.config.ts`](/observability/cli) |

## Quy tắc Quản trị

- Bất kỳ thay đổi phá vỡ tương thích (breaking change) nào đối với hợp đồng lõi (`@bunest/core`, `@bunest/validation`, `@bunest/security`) BẮT BUỘC phải đề xuất một ADR mới (hoặc đánh dấu ADR bị thay thế là `Superseded by ADR-NNN`) ghi rõ bối cảnh, đánh đổi và tác động chuyển đổi.
- Các bài kiểm thử triển khai trong `@bunest/*` tham chiếu chéo trực tiếp và thực thi các bất biến `MUST` / `MUST NOT` được chốt trong các bản ghi này.
