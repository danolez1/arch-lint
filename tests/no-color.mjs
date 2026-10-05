// Child processes inherit this environment, and a color-forcing variable in a developer's shell would put escape codes inside the output the tests match.
process.env.FORCE_COLOR = "0";
delete process.env.NO_COLOR;
delete process.env.CLICOLOR_FORCE;
