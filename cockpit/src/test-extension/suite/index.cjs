const path = require("node:path");
const Mocha = require("mocha");
const { glob } = require("glob");

async function run() {
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
    timeout: 30000
  });

  const testsRoot = __dirname;
  const files = await glob("**/*.test.cjs", { cwd: testsRoot, nodir: true });

  for (const file of files) {
    mocha.addFile(path.resolve(testsRoot, file));
  }

  await new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} test(s) failed.`));
        return;
      }
      resolve();
    });
  });
}

module.exports = {
  run
};
