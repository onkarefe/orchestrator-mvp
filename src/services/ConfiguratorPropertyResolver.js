export const PRIVATE_CONFIGURATOR_PAYLOAD_PROPERTY =
  '_configurator_payload';
export const LEGACY_CONFIGURATOR_PAYLOAD_PROPERTY =
  'configurator_payload';
export const PRIVATE_CONFIGURATOR_INSTANCE_PROPERTY =
  '_configurator_instance_id';
export const LEGACY_CONFIGURATOR_INSTANCE_PROPERTY =
  'configurator_instance_id';

function resolvePropertyValue(properties, privateName, legacyName) {
  const normalizedProperties = Array.isArray(properties) ? properties : [];
  const privateProperty = normalizedProperties.find(
    (property) => property?.name === privateName
  );

  if (privateProperty) {
    return privateProperty.value ?? null;
  }

  const legacyProperty = normalizedProperties.find(
    (property) => property?.name === legacyName
  );

  return legacyProperty?.value ?? null;
}

export function resolveConfiguratorProperties(properties) {
  return {
    // An empty or malformed private value still marks a configurator line.
    hasMarker: (Array.isArray(properties) ? properties : []).some(
      (property) =>
        [
          PRIVATE_CONFIGURATOR_PAYLOAD_PROPERTY,
          LEGACY_CONFIGURATOR_PAYLOAD_PROPERTY,
          PRIVATE_CONFIGURATOR_INSTANCE_PROPERTY,
          LEGACY_CONFIGURATOR_INSTANCE_PROPERTY,
        ].includes(property?.name)
    ),
    payload: resolvePropertyValue(
      properties,
      PRIVATE_CONFIGURATOR_PAYLOAD_PROPERTY,
      LEGACY_CONFIGURATOR_PAYLOAD_PROPERTY
    ),
    instanceId: resolvePropertyValue(
      properties,
      PRIVATE_CONFIGURATOR_INSTANCE_PROPERTY,
      LEGACY_CONFIGURATOR_INSTANCE_PROPERTY
    ),
  };
}

export default {
  PRIVATE_CONFIGURATOR_PAYLOAD_PROPERTY,
  LEGACY_CONFIGURATOR_PAYLOAD_PROPERTY,
  PRIVATE_CONFIGURATOR_INSTANCE_PROPERTY,
  LEGACY_CONFIGURATOR_INSTANCE_PROPERTY,
  resolveConfiguratorProperties,
};
