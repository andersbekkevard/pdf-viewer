# The ABI of the two PDFium calls used by the character scan in pdfium_doc.py.
# The wheel still owns the library and text-page lifetime.
from libc.stdint cimport uintptr_t
cdef extern from *:
    """
    #include <stdint.h>
    typedef struct { float left, top, right, bottom; } ScanRect;
    typedef struct {
      unsigned int (*unicode_at)(void *, int);
      int (*loose_box)(void *, int, ScanRect *);
    } ScanAPI;
    static ScanAPI scan_api(uintptr_t code, uintptr_t box) {
      ScanAPI api = { (unsigned int (*)(void *, int)) code,
                      (int (*)(void *, int, ScanRect *)) box };
      return api;
    }
    """
    ctypedef struct ScanRect:
        float left
        float top
        float right
        float bottom
    ctypedef struct ScanAPI:
        unsigned int unicode_at(void *, int)
        int loose_box(void *, int, ScanRect *)
    ScanAPI scan_api(uintptr_t, uintptr_t)
    const char *build_source_sha "PDFV_TEXT_SOURCE_SHA"
