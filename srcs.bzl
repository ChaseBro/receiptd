"""srcs_filegroup: every file in a package and the packages below it.

The repository's `:files` (what notes depends on) has to cover the Go sources
too, but a glob stops at a package boundary and Gazelle puts a BUILD file in
every Go package. So each package declares `srcs_filegroup()`, which globs its
own files and pulls in each subpackage's `:srcs` — a source-file edge, never a
compiled one, so depending on `:files` builds nothing. A new package without
the line breaks `bazel build //...` at the root, which is how it gets noticed.
"""

def srcs_filegroup(name = "srcs", exclude = [], visibility = ["//visibility:public"]):
    pkg = native.package_name()
    prefix = "//" + pkg + "/" if pkg else "//"
    native.filegroup(
        name = name,
        srcs = native.glob(["**"], exclude = exclude + ["**/.DS_Store"], allow_empty = True) +
               [prefix + sub + ":srcs" for sub in native.subpackages(include = ["**"], allow_empty = True)],
        visibility = visibility,
    )
