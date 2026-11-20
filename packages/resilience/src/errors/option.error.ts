/**
 * @internal An invalid option, named by its path: `maxConcurrent` where a
 * policy is created, `presets.carrier.bulkhead.maxConcurrent` at bootstrap.
 */
export class OptionError extends TypeError {
  readonly option: string;
  readonly problem: string;

  constructor(option: string, problem: string) {
    super(option ? `${option}: ${problem}` : problem);
    this.option = option;
    this.problem = problem;
    this.name = "TypeError";
  }
}
