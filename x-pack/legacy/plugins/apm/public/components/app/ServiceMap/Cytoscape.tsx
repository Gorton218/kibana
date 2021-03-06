/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import cytoscape from 'cytoscape';
import React, {
  createContext,
  CSSProperties,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react';
import { isRumAgentName } from '../../../../../../../plugins/apm/common/agent_name';
import { AGENT_NAME } from '../../../../../../../plugins/apm/common/elasticsearch_fieldnames';
import {
  animationOptions,
  cytoscapeOptions,
  nodeHeight
} from './cytoscapeOptions';

export const CytoscapeContext = createContext<cytoscape.Core | undefined>(
  undefined
);

interface CytoscapeProps {
  children?: ReactNode;
  elements: cytoscape.ElementDefinition[];
  height: number;
  width: number;
  serviceName?: string;
  style?: CSSProperties;
}

function useCytoscape(options: cytoscape.CytoscapeOptions) {
  const [cy, setCy] = useState<cytoscape.Core | undefined>(undefined);
  const ref = useRef(null);

  useEffect(() => {
    if (!cy) {
      setCy(cytoscape({ ...options, container: ref.current }));
    }
  }, [options, cy]);

  // Destroy the cytoscape instance on unmount
  useEffect(() => {
    return () => {
      if (cy) {
        cy.destroy();
      }
    };
  }, [cy]);

  return [ref, cy] as [React.MutableRefObject<any>, cytoscape.Core | undefined];
}

function rotatePoint(
  { x, y }: { x: number; y: number },
  degreesRotated: number
) {
  const radiansPerDegree = Math.PI / 180;
  const θ = radiansPerDegree * degreesRotated;
  const cosθ = Math.cos(θ);
  const sinθ = Math.sin(θ);
  return {
    x: x * cosθ - y * sinθ,
    y: x * sinθ + y * cosθ
  };
}

function getLayoutOptions(
  selectedRoots: string[],
  height: number,
  width: number
): cytoscape.LayoutOptions {
  return {
    name: 'breadthfirst',
    roots: selectedRoots.length ? selectedRoots : undefined,
    fit: true,
    padding: nodeHeight,
    spacingFactor: 0.85,
    animate: true,
    animationEasing: animationOptions.easing,
    animationDuration: animationOptions.duration,
    // @ts-ignore
    // Rotate nodes counter-clockwise to transform layout from top→bottom to left→right.
    // The extra 5° achieves the effect of separating overlapping taxi-styled edges.
    transform: (node: any, pos: cytoscape.Position) => rotatePoint(pos, -95),
    // swap width/height of boundingBox to compensate for the rotation
    boundingBox: { x1: 0, y1: 0, w: height, h: width }
  };
}

function selectRoots(cy: cytoscape.Core): string[] {
  const nodes = cy.nodes();
  const roots = nodes.roots();
  const rumNodes = nodes.filter(node => isRumAgentName(node.data(AGENT_NAME)));
  return rumNodes.union(roots).map(node => node.id());
}

export function Cytoscape({
  children,
  elements,
  height,
  width,
  serviceName,
  style
}: CytoscapeProps) {
  const initialElements = elements.map(element => ({
    ...element,
    // prevents flash of unstyled elements
    classes: [element.classes, 'invisible'].join(' ').trim()
  }));

  const [ref, cy] = useCytoscape({
    ...cytoscapeOptions,
    elements: initialElements
  });

  // Add the height to the div style. The height is a separate prop because it
  // is required and can trigger rendering when changed.
  const divStyle = { ...style, height };

  const resetConnectedEdgeStyle = useCallback(
    (node?: cytoscape.NodeSingular) => {
      if (cy) {
        cy.edges().removeClass('highlight');

        if (node) {
          node.connectedEdges().addClass('highlight');
        }
      }
    },
    [cy]
  );

  const dataHandler = useCallback<cytoscape.EventHandler>(
    event => {
      if (cy) {
        if (serviceName) {
          resetConnectedEdgeStyle(cy.getElementById(serviceName));
          // Add the "primary" class to the node if its id matches the serviceName.
          if (cy.nodes().length > 0) {
            cy.nodes().removeClass('primary');
            cy.getElementById(serviceName).addClass('primary');
          }
        } else {
          resetConnectedEdgeStyle();
        }
        if (event.cy.elements().length > 0) {
          const selectedRoots = selectRoots(event.cy);
          const layout = cy.layout(
            getLayoutOptions(selectedRoots, height, width)
          );
          layout.one('layoutstop', () => {
            if (serviceName) {
              const focusedNode = cy.getElementById(serviceName);
              cy.center(focusedNode);
            }
            // show elements after layout is applied
            cy.elements().removeClass('invisible');
          });
          layout.run();
        }
      }
    },
    [cy, resetConnectedEdgeStyle, serviceName, height, width]
  );

  // Trigger a custom "data" event when data changes
  useEffect(() => {
    if (cy) {
      cy.add(elements);
      cy.trigger('data');
    }
  }, [cy, elements]);

  // Set up cytoscape event handlers
  useEffect(() => {
    const mouseoverHandler: cytoscape.EventHandler = event => {
      event.target.addClass('hover');
      event.target.connectedEdges().addClass('nodeHover');
    };
    const mouseoutHandler: cytoscape.EventHandler = event => {
      event.target.removeClass('hover');
      event.target.connectedEdges().removeClass('nodeHover');
    };
    const selectHandler: cytoscape.EventHandler = event => {
      resetConnectedEdgeStyle(event.target);
    };
    const unselectHandler: cytoscape.EventHandler = event => {
      resetConnectedEdgeStyle();
    };

    if (cy) {
      cy.on('data', dataHandler);
      cy.ready(dataHandler);
      cy.on('mouseover', 'edge, node', mouseoverHandler);
      cy.on('mouseout', 'edge, node', mouseoutHandler);
      cy.on('select', 'node', selectHandler);
      cy.on('unselect', 'node', unselectHandler);
    }

    return () => {
      if (cy) {
        cy.removeListener(
          'data',
          undefined,
          dataHandler as cytoscape.EventHandler
        );
        cy.removeListener('mouseover', 'edge, node', mouseoverHandler);
        cy.removeListener('mouseout', 'edge, node', mouseoutHandler);
      }
    };
  }, [cy, dataHandler, resetConnectedEdgeStyle, serviceName]);

  return (
    <CytoscapeContext.Provider value={cy}>
      <div ref={ref} style={divStyle}>
        {children}
      </div>
    </CytoscapeContext.Provider>
  );
}
