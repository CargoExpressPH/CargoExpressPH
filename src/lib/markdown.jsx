import React from 'react';

export const renderMarkdown = (text) => {
  if (!text) return null;
  
  // Split by newline first
  const lines = text.split('\n');
  
  return lines.map((line, lineIndex) => {
    if (!line) return <br key={lineIndex} />;
    
    // Simple parser for **bold**, *italic*, and [links](url)
    const elements = [];
    let currentText = '';
    let i = 0;
    
    while (i < line.length) {
      if (line.substring(i, i + 2) === '**') {
        if (currentText) elements.push(<span key={i + 't'}>{currentText}</span>);
        currentText = '';
        i += 2;
        const end = line.indexOf('**', i);
        if (end !== -1) {
          elements.push(<strong key={i}>{line.substring(i, end)}</strong>);
          i = end + 2;
        } else {
          currentText += '**';
        }
      } else if (line[i] === '*' && (i === 0 || line[i-1] === ' ') && line[i+1] !== ' ') {
        if (currentText) elements.push(<span key={i + 't'}>{currentText}</span>);
        currentText = '';
        i += 1;
        const end = line.indexOf('*', i);
        if (end !== -1) {
          elements.push(<em key={i}>{line.substring(i, end)}</em>);
          i = end + 1;
        } else {
          currentText += '*';
        }
      } else if (line[i] === '[') {
        const endBracket = line.indexOf(']', i);
        if (endBracket !== -1 && line[endBracket + 1] === '(') {
          const endParen = line.indexOf(')', endBracket);
          if (endParen !== -1) {
            if (currentText) elements.push(<span key={i + 't'}>{currentText}</span>);
            currentText = '';
            const linkText = line.substring(i + 1, endBracket);
            const linkUrl = line.substring(endBracket + 2, endParen);
            // Only allow safe URL schemes — block javascript:, data:, vbscript: etc.
            const isSafeUrl = /^(https?:\/\/|\/(?!\/))/i.test(linkUrl.trim());
            if (isSafeUrl) {
              elements.push(<a key={i} href={linkUrl} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline">{linkText}</a>);
            } else {
              elements.push(<span key={i}>{linkText}</span>);
            }
            i = endParen + 1;
            continue;
          }
        }
        currentText += line[i];
        i++;
      } else {
        currentText += line[i];
        i++;
      }
    }
    
    if (currentText) elements.push(<span key="end">{currentText}</span>);
    
    return (
      <span key={lineIndex}>
        {elements.length > 0 ? elements : line}
        {lineIndex < lines.length - 1 && <br />}
      </span>
    );
  });
};
