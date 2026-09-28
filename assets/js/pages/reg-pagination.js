var regCurrentPage = 1;

function buildPageList(current, total) {
    var maxVisible = 5;
    if (total <= maxVisible + 2) {
        return Array.from({ length: total }, function (_, i) { return i + 1; });
    }
    var start = Math.max(1, current - Math.floor(maxVisible / 2));
    var end = start + maxVisible - 1;
    if (end > total) { end = total; start = Math.max(1, end - maxVisible + 1); }
    var pages = [];
    for (var i = start; i <= end; i++) pages.push(i);
    if (start > 1) { pages.unshift('...'); pages.unshift(1); }
    if (end < total) { pages.push('...'); pages.push(total); }
    return pages;
}

function buildPaginationHtml(current, total, onClickFn) {
    if (total <= 1) return '';
    var pageItem = function(label, page, opts) {
        opts = opts || {};
        var disabled = opts.disabled ? ' disabled' : '';
        var active = opts.active ? ' active' : '';
        var isEllipsis = opts.ellipsis ? ' ellipsis-item' : '';
        var isPrevNext = opts.isPrev ? ' page-link-prev' : (opts.isNext ? ' page-link-next' : '');
        var click = opts.disabled || opts.ellipsis ? '' : 'onclick="' + onClickFn + '(' + page + ')"';
        return '<li class="page-item' + disabled + active + isEllipsis + '"><a class="page-link' + isPrevNext + '" href="javascript:void(0)" ' + click + '>' + label + '</a></li>';
    };
    var html = pageItem('&lsaquo; Previous', current - 1, { disabled: current === 1, isPrev: true });
    buildPageList(current, total).forEach(function(p) {
        html += (p === '...')
            ? pageItem('&hellip;', null, { ellipsis: true, disabled: true })
            : pageItem(p, p, { active: p === current });
    });
    html += pageItem('Next &rsaquo;', current + 1, { disabled: current === total, isNext: true });
    return '<div class="d-flex justify-content-end mb-3"><ul class="pagination pagination-custom align-items-center m-0">' + html + '</ul></div>';
}

function goToRegPage(p) {
    regCurrentPage = p;
    buildGrid();
}
