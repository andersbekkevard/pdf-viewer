"""Build the exact PDFium text loop as an optional module for the worker."""
import hashlib
from pathlib import Path
import sys

from Cython.Build import cythonize
from setuptools import Extension, setup

# Keep Python's separate multiply/add rounding on both Intel and Apple Silicon.
float_flags = ["/fp:strict"] if sys.platform == "win32" else ["-ffp-contract=off"]
source = Path("pdfium_doc.py").read_bytes()
bindings = Path("pdfium_text_bindings.pxd").read_bytes()
source_sha = hashlib.sha256(source + bindings).hexdigest()
native = Extension(
    "_pdfv_pdfium_native",
    ["pdfium_doc.py"],
    extra_compile_args=float_flags,
    define_macros=[("PDFV_TEXT_SOURCE_SHA", f'"{source_sha}"')],
    optional=True,
)
setup(
    packages=[],
    py_modules=[],
    ext_modules=cythonize(
        [native],
        compiler_directives={"annotation_typing": False},
        build_dir="build/cython",
    ),
)
