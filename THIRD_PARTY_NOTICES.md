# Third-Party Notices

Bunest ships with **zero third-party runtime dependencies**. This file lists third-party material that is
included in the repository for other purposes.

## NestJS conformance tests

The files under [`tests/nestjs-conformance/`](./tests/nestjs-conformance) are ported or adapted from the test suites of the
official NestJS repositories (`github.com/nestjs/nest` and its official ecosystem repositories, e.g.
`nestjs/axios`, `nestjs/cache-manager`, `nestjs/config`, `nestjs/cqrs`, `nestjs/event-emitter`,
`nestjs/mapped-types`, `nestjs/schedule`, `nestjs/swagger`, `nestjs/graphql`, `nestjs/jwt`, `nestjs/throttler`,
`nestjs/passport`, `nestjs/bull`, `nestjs/terminus`, `nestjs/nest-cli`, `nestjs/schematics`, `nestjs/typeorm`).
Each ported spec records its upstream path in its `describeConformance({ upstreamPath })` metadata, and
[`inventory.json`](./tests/nestjs-conformance/inventory.json) records the upstream commit of every repository.

Bunest is an independent project and is not affiliated with or endorsed by the NestJS project. "NestJS" is used
only to describe API compatibility.

These upstream projects are licensed under the MIT License:

```text
(The MIT License)

Copyright (c) 2017-present Kamil Mysliwiec <https://kamilmysliwiec.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
