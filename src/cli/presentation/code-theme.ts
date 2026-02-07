import chalk from "chalk";

function getCodeColor(): (text: string) => string {
  if (chalk.level === 3) {
    return chalk.hex("#6272a4");
  }
  if (chalk.level === 2) {
    return chalk.ansi256(250);
  }
  return chalk.greenBright;
}

export const codeColor: (text: string) => string = getCodeColor();
